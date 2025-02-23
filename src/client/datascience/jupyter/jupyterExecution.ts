// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { Kernel } from '@jupyterlab/services';
import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as uuid from 'uuid/v4';
import { CancellationToken, Event, EventEmitter } from 'vscode';

import { IApplicationShell, ILiveShareApi, IWorkspaceService } from '../../common/application/types';
import { Cancellation, CancellationError } from '../../common/cancellation';
import { traceInfo } from '../../common/logger';
import { IFileSystem, TemporaryDirectory } from '../../common/platform/types';
import { IProcessServiceFactory, IPythonExecutionFactory, SpawnOptions } from '../../common/process/types';
import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, ILogger } from '../../common/types';
import * as localize from '../../common/utils/localize';
import { noop } from '../../common/utils/misc';
import { StopWatch } from '../../common/utils/stopWatch';
import { EXTENSION_ROOT_DIR } from '../../constants';
import { IInterpreterService, IKnownSearchPathsForInterpreters, PythonInterpreter } from '../../interpreter/contracts';
import { IServiceContainer } from '../../ioc/types';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { JupyterCommands, RegExpValues, Telemetry } from '../constants';
import {
    IConnection,
    IJupyterCommandFactory,
    IJupyterExecution,
    IJupyterKernelSpec,
    IJupyterSessionManager,
    IJupyterSessionManagerFactory,
    INotebookServer,
    INotebookServerLaunchInfo,
    INotebookServerOptions
} from '../types';
import { IFindCommandResult, JupyterCommandFinder } from './jupyterCommandFinder';
import { JupyterConnection, JupyterServerInfo } from './jupyterConnection';
import { JupyterInstallError } from './jupyterInstallError';
import { JupyterKernelSpec } from './jupyterKernelSpec';
import { JupyterSelfCertsError } from './jupyterSelfCertsError';
import { createConnectionInfo } from './jupyterUtils';
import { JupyterWaitForIdleError } from './jupyterWaitForIdleError';

export class JupyterExecutionBase implements IJupyterExecution {

    private usablePythonInterpreter: PythonInterpreter | undefined;
    private eventEmitter: EventEmitter<void> = new EventEmitter<void>();
    private disposed: boolean = false;
    private readonly commandFinder: JupyterCommandFinder;

    constructor(
        _liveShare: ILiveShareApi,
        private readonly executionFactory: IPythonExecutionFactory,
        private readonly interpreterService: IInterpreterService,
        private readonly processServiceFactory: IProcessServiceFactory,
        knownSearchPaths: IKnownSearchPathsForInterpreters,
        private readonly logger: ILogger,
        private readonly disposableRegistry: IDisposableRegistry,
        private readonly asyncRegistry: IAsyncDisposableRegistry,
        private readonly fileSystem: IFileSystem,
        private readonly sessionManagerFactory: IJupyterSessionManagerFactory,
        workspace: IWorkspaceService,
        private readonly configuration: IConfigurationService,
        commandFactory: IJupyterCommandFactory,
        private readonly serviceContainer: IServiceContainer
    ) {
        this.commandFinder = new JupyterCommandFinder(interpreterService, executionFactory,
            configuration, knownSearchPaths, disposableRegistry,
            fileSystem, logger, processServiceFactory,
            commandFactory, workspace,
            serviceContainer.get<IApplicationShell>(IApplicationShell));
        this.disposableRegistry.push(this.interpreterService.onDidChangeInterpreter(() => this.onSettingsChanged()));
        this.disposableRegistry.push(this);

        if (workspace) {
            const disposable = workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('python.dataScience', undefined)) {
                    // When config changes happen, recreate our commands.
                    this.onSettingsChanged();
                }
            });
            this.disposableRegistry.push(disposable);
        }
    }

    public get sessionChanged(): Event<void> {
        return this.eventEmitter.event;
    }

    public dispose(): Promise<void> {
        this.disposed = true;
        return Promise.resolve();
    }

    public isNotebookSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command notebook
        return Cancellation.race(() => this.isCommandSupported(JupyterCommands.NotebookCommand, cancelToken), cancelToken);
    }

    public async getNotebookError(): Promise<string> {
        const notebook = await this.findBestCommand(JupyterCommands.NotebookCommand);
        return notebook.error ? notebook.error : localize.DataScience.notebookNotFound();
    }

    public async getUsableJupyterPython(cancelToken?: CancellationToken): Promise<PythonInterpreter | undefined> {
        // Only try to compute this once.
        if (!this.usablePythonInterpreter && !this.disposed) {
            this.usablePythonInterpreter = await Cancellation.race(() => this.getUsableJupyterPythonImpl(cancelToken), cancelToken);
        }
        return this.usablePythonInterpreter;
    }

    public isImportSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command nbconvert
        return Cancellation.race(() => this.isCommandSupported(JupyterCommands.ConvertCommand), cancelToken);
    }

    public isKernelCreateSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command ipykernel
        return Cancellation.race(() => this.isCommandSupported(JupyterCommands.KernelCreateCommand), cancelToken);
    }

    public isKernelSpecSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command kernelspec
        return Cancellation.race(() => this.isCommandSupported(JupyterCommands.KernelSpecCommand), cancelToken);
    }

    public isSpawnSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // Supported if we can run a notebook
        return this.isNotebookSupported(cancelToken);
    }

    //tslint:disable:cyclomatic-complexity
    public connectToNotebookServer(options?: INotebookServerOptions, cancelToken?: CancellationToken): Promise<INotebookServer | undefined> {
        // Return nothing if we cancel
        return Cancellation.race(async () => {
            let result: INotebookServer | undefined;
            let startInfo: { connection: IConnection; kernelSpec: IJupyterKernelSpec | undefined } | undefined;
            traceInfo(`Connecting to ${options ? options.purpose : 'unknown type of'} server`);
            const interpreter = await this.interpreterService.getActiveInterpreter();

            // Try to connect to our jupyter process. Check our setting for the number of tries
            let tryCount = 0;
            const maxTries = this.configuration.getSettings().datascience.jupyterLaunchRetries;
            while (tryCount < maxTries) {
                try {
                    // Start or connect to the process
                    startInfo = await this.startOrConnect(options, cancelToken);

                    // Create a server that we will then attempt to connect to.
                    result = this.serviceContainer.get<INotebookServer>(INotebookServer);

                    // Populate the launch info that we are starting our server with
                    const launchInfo: INotebookServerLaunchInfo = {
                        connectionInfo: startInfo.connection,
                        currentInterpreter: interpreter,
                        kernelSpec: startInfo.kernelSpec,
                        workingDir: options ? options.workingDir : undefined,
                        uri: options ? options.uri : undefined,
                        purpose: options ? options.purpose : uuid(),
                        enableDebugging: options ? options.enableDebugging : false
                    };

                    traceInfo(`Connecting to process for ${options ? options.purpose : 'unknown type of'} server`);
                    await result.connect(launchInfo, cancelToken);
                    traceInfo(`Connection complete for ${options ? options.purpose : 'unknown type of'} server`);

                    sendTelemetryEvent(launchInfo.uri ? Telemetry.ConnectRemoteJupyter : Telemetry.ConnectLocalJupyter);
                    return result;
                } catch (err) {
                    // Cleanup after ourselves. server may be running partially.
                    if (result) {
                        traceInfo('Killing server because of error');
                        await result.dispose();
                    }
                    if (err instanceof JupyterWaitForIdleError && tryCount < maxTries) {
                        // Special case. This sometimes happens where jupyter doesn't ever connect. Cleanup after
                        // ourselves and propagate the failure outwards.
                        traceInfo('Retry because of wait for idle problem.');
                        tryCount += 1;
                    } else if (startInfo) {
                        // Something else went wrong
                        if (options && options.uri) {
                            sendTelemetryEvent(Telemetry.ConnectRemoteFailedJupyter);

                            // Check for the self signed certs error specifically
                            if (err.message.indexOf('reason: self signed certificate') >= 0) {
                                sendTelemetryEvent(Telemetry.ConnectRemoteSelfCertFailedJupyter);
                                throw new JupyterSelfCertsError(startInfo.connection.baseUrl);
                            } else {
                                throw new Error(localize.DataScience.jupyterNotebookRemoteConnectFailed().format(startInfo.connection.baseUrl, err));
                            }
                        } else {
                            sendTelemetryEvent(Telemetry.ConnectFailedJupyter);
                            throw new Error(localize.DataScience.jupyterNotebookConnectFailed().format(startInfo.connection.baseUrl, err));
                        }
                    } else {
                        throw err;
                    }
                }
            }
        }, cancelToken);
    }

    public async spawnNotebook(file: string): Promise<void> {
        // First we find a way to start a notebook server
        const notebookCommand = await this.findBestCommand(JupyterCommands.NotebookCommand);
        this.checkNotebookCommand(notebookCommand);

        const args: string[] = [`--NotebookApp.file_to_run=${file}`];

        // Don't wait for the exec to finish and don't dispose. It's up to the user to kill the process
        notebookCommand.command!.exec(args, { throwOnStdErr: false, encoding: 'utf8' }).ignoreErrors();
    }

    public async importNotebook(file: string, template: string | undefined): Promise<string> {
        // First we find a way to start a nbconvert
        const convert = await this.findBestCommand(JupyterCommands.ConvertCommand);
        if (!convert.command) {
            throw new Error(localize.DataScience.jupyterNbConvertNotSupported());
        }

        // Wait for the nbconvert to finish
        const args = template ? [file, '--to', 'python', '--stdout', '--template', template] : [file, '--to', 'python', '--stdout'];
        const result = await convert.command.exec(args, { throwOnStdErr: false, encoding: 'utf8' });
        if (result.stderr) {
            // Stderr on nbconvert doesn't indicate failure. Just log the result
            this.logger.logInformation(result.stderr);
        }
        return result.stdout;
    }

    public getServer(_options?: INotebookServerOptions): Promise<INotebookServer | undefined> {
        // This is cached at the host or guest level
        return Promise.resolve(undefined);
    }

    @captureTelemetry(Telemetry.FindJupyterKernelSpec)
    protected async getMatchingKernelSpec(sessionManager: IJupyterSessionManager | undefined, cancelToken?: CancellationToken): Promise<IJupyterKernelSpec | undefined> {
        try {
            // If not using an active connection, check on disk
            if (!sessionManager) {
                traceInfo('Searching for best interpreter');

                // Get our best interpreter. We want its python path
                const bestInterpreter = await this.getUsableJupyterPython(cancelToken);

                traceInfo(`Best interpreter is ${bestInterpreter ? bestInterpreter.path : 'notfound'}`);

                // Enumerate our kernel specs that jupyter will know about and see if
                // one of them already matches based on path
                if (bestInterpreter && !await this.hasSpecPathMatch(bestInterpreter, cancelToken)) {

                    // Nobody matches on path, so generate a new kernel spec
                    if (await this.isKernelCreateSupported(cancelToken)) {
                        await this.addMatchingSpec(bestInterpreter, cancelToken);
                    }
                }
            }

            // Now enumerate them again
            const enumerator = sessionManager ? () => sessionManager.getActiveKernelSpecs() : () => this.enumerateSpecs(cancelToken);

            // Then find our match
            return this.findSpecMatch(enumerator);
        } catch (e) {
            // ECONNREFUSED seems to happen here. Log the error, but don't let it bubble out. We don't really need a kernel spec
            this.logger.logWarning(e);

            // Double check our jupyter server is still running.
            if (sessionManager && sessionManager.getConnInfo().localProcExitCode) {
                throw new Error(localize.DataScience.jupyterServerCrashed().format(sessionManager!.getConnInfo().localProcExitCode!.toString()));
            }
        }
    }

    protected async findBestCommand(command: JupyterCommands, cancelToken?: CancellationToken): Promise<IFindCommandResult> {
        return this.commandFinder.findBestCommand(command, cancelToken);
    }

    private checkNotebookCommand(notebook: IFindCommandResult) {
        if (!notebook.command) {
            const errorMessage = notebook.error ? notebook.error : localize.DataScience.notebookNotFound();
            throw new JupyterInstallError(localize.DataScience.jupyterNotSupported().format(errorMessage), localize.DataScience.pythonInteractiveHelpLink());
        }
    }

    private async startOrConnect(options?: INotebookServerOptions, cancelToken?: CancellationToken): Promise<{ connection: IConnection; kernelSpec: IJupyterKernelSpec | undefined }> {
        let connection: IConnection | undefined;
        let kernelSpec: IJupyterKernelSpec | undefined;

        // If our uri is undefined or if it's set to local launch we need to launch a server locally
        if (!options || !options.uri) {
            traceInfo(`Launching ${options ? options.purpose : 'unknown type of'} server`);
            const launchResults = await this.startNotebookServer(options && options.useDefaultConfig ? true : false, cancelToken);
            if (launchResults) {
                connection = launchResults.connection;
                kernelSpec = launchResults.kernelSpec;
            } else {
                // Throw a cancellation error if we were canceled.
                Cancellation.throwIfCanceled(cancelToken);

                // Otherwise we can't connect
                throw new Error(localize.DataScience.jupyterNotebookFailure().format(''));
            }
        } else {
            // If we have a URI spec up a connection info for it
            connection = this.createRemoteConnectionInfo(options.uri);
            const settings = this.configuration.getSettings();
            kernelSpec = settings.datascience.jupyterServerKernelSpec;
        }

        // If we don't have a kernel spec yet, check using our current connection
        if (!kernelSpec && connection.localLaunch) {
            traceInfo(`Getting kernel specs for ${options ? options.purpose : 'unknown type of'} server`);
            const sessionManager = await this.sessionManagerFactory.create(connection);
            kernelSpec = await this.getMatchingKernelSpec(sessionManager, cancelToken);
            await sessionManager.dispose();
        }

        // If still not found, log an error (this seems possible for some people, so use the default)
        if (!kernelSpec && connection.localLaunch) {
            this.logger.logError(localize.DataScience.jupyterKernelSpecNotFound());
        }

        // Return the data we found.
        return { connection, kernelSpec };
    }

    private createRemoteConnectionInfo = (uri: string): IConnection => {
        return createConnectionInfo(uri, this.configuration.getSettings());
    }

    // tslint:disable-next-line: max-func-body-length
    @captureTelemetry(Telemetry.StartJupyter)
    private async startNotebookServer(useDefaultConfig: boolean, cancelToken?: CancellationToken): Promise<{ connection: IConnection; kernelSpec: IJupyterKernelSpec | undefined }> {
        // First we find a way to start a notebook server
        const notebookCommand = await this.findBestCommand(JupyterCommands.NotebookCommand, cancelToken);
        this.checkNotebookCommand(notebookCommand);

        // Now actually launch it
        let exitCode = 0;
        try {
            // Generate a temp dir with a unique GUID, both to match up our started server and to easily clean up after
            const tempDir = await this.generateTempDir();
            this.disposableRegistry.push(tempDir);

            // In the temp dir, create an empty config python file. This is the same
            // as starting jupyter with all of the defaults.
            const configFile = useDefaultConfig ? path.join(tempDir.path, 'jupyter_notebook_config.py') : undefined;
            if (configFile) {
                await this.fileSystem.writeFile(configFile, '');
                this.logger.logInformation(`Generating custom default config at ${configFile}`);
            }

            // Create extra args based on if we have a config or not
            const extraArgs: string[] = [];
            if (useDefaultConfig) {
                extraArgs.push(`--config=${configFile}`);
            }
            // Check for the debug environment variable being set. Setting this
            // causes Jupyter to output a lot more information about what it's doing
            // under the covers and can be used to investigate problems with Jupyter.
            if (process.env && process.env.VSCODE_PYTHON_DEBUG_JUPYTER) {
                extraArgs.push('--debug');
            }

            // Modify the data rate limit if starting locally. The default prevents large dataframes from being returned.
            extraArgs.push('--NotebookApp.iopub_data_rate_limit=10000000000.0');

            // Check for a docker situation.
            try {
                if (await this.fileSystem.fileExists('/proc/self/cgroup')) {
                    const cgroup = await this.fileSystem.readFile('/proc/self/cgroup');
                    if (cgroup.includes('docker')) {
                        // We definitely need an ip address.
                        extraArgs.push('--ip');
                        extraArgs.push('127.0.0.1');

                        // Now see if we need --allow-root.
                        const idResults = execSync('id', { encoding: 'utf-8' });
                        if (idResults.includes('(root)')) {
                            extraArgs.push('--allow-root');
                        }
                    }
                }
            } catch {
                noop();
            }

            // Use this temp file and config file to generate a list of args for our command
            const args: string[] = [...['--no-browser', `--notebook-dir=${tempDir.path}`], ...extraArgs];

            // Before starting the notebook process, make sure we generate a kernel spec
            const kernelSpec = await this.getMatchingKernelSpec(undefined, cancelToken);

            // Make sure we haven't canceled already.
            if (cancelToken && cancelToken.isCancellationRequested) {
                throw new CancellationError();
            }

            // Then use this to launch our notebook process.
            const stopWatch = new StopWatch();
            const launchResult = await notebookCommand.command!.execObservable(args, { throwOnStdErr: false, encoding: 'utf8', token: cancelToken });

            // Watch for premature exits
            if (launchResult.proc) {
                launchResult.proc.on('exit', (c) => exitCode = c);
            }

            // Make sure this process gets cleaned up. We might be canceled before the connection finishes.
            if (launchResult && cancelToken) {
                cancelToken.onCancellationRequested(() => {
                    launchResult.dispose();
                });
            }

            // Wait for the connection information on this result
            const connection = await JupyterConnection.waitForConnection(
                tempDir.path, this.getJupyterServerInfo, launchResult, this.serviceContainer, cancelToken);

            // Fire off telemetry for the process being talkable
            sendTelemetryEvent(Telemetry.StartJupyterProcess, stopWatch.elapsedTime);

            return {
                connection: connection,
                kernelSpec: kernelSpec
            };
        } catch (err) {
            if (err instanceof CancellationError) {
                throw err;
            }

            // Something else went wrong. See if the local proc died or not.
            if (exitCode !== 0) {
                throw new Error(localize.DataScience.jupyterServerCrashed().format(exitCode.toString()));
            } else {
                throw new Error(localize.DataScience.jupyterNotebookFailure().format(err));
            }
        }
    }

    private getUsableJupyterPythonImpl = async (cancelToken?: CancellationToken): Promise<PythonInterpreter | undefined> => {
        // This should be the best interpreter for notebooks
        const found = await this.findBestCommand(JupyterCommands.NotebookCommand, cancelToken);
        if (found && found.command) {
            return found.command.interpreter();
        }

        return undefined;
    }

    private getJupyterServerInfo = async (cancelToken?: CancellationToken): Promise<JupyterServerInfo[] | undefined> => {
        // We have a small python file here that we will execute to get the server info from all running Jupyter instances
        const bestInterpreter = await this.getUsableJupyterPython(cancelToken);
        if (bestInterpreter) {
            const newOptions: SpawnOptions = { mergeStdOutErr: true, token: cancelToken };
            const launcher = await this.executionFactory.createActivatedEnvironment(
                { resource: undefined, interpreter: bestInterpreter, allowEnvironmentFetchExceptions: true });
            const file = path.join(EXTENSION_ROOT_DIR, 'pythonFiles', 'datascience', 'getServerInfo.py');
            const serverInfoString = await launcher.exec([file], newOptions);

            let serverInfos: JupyterServerInfo[];
            try {
                // Parse out our results, return undefined if we can't suss it out
                serverInfos = JSON.parse(serverInfoString.stdout.trim()) as JupyterServerInfo[];
            } catch (err) {
                return undefined;
            }
            return serverInfos;
        }

        return undefined;
    }

    private onSettingsChanged() {
        // Clear our usableJupyterInterpreter so that we recompute our values
        this.usablePythonInterpreter = undefined;
    }

    private async addMatchingSpec(bestInterpreter: PythonInterpreter, cancelToken?: CancellationToken): Promise<void> {
        const displayName = localize.DataScience.historyTitle();
        const ipykernelCommand = await this.findBestCommand(JupyterCommands.KernelCreateCommand, cancelToken);

        // If this fails, then we just skip this spec
        try {
            // Run the ipykernel install command. This will generate a new kernel spec. However
            // it will be pointing to the python that ran it. We'll fix that up afterwards
            const name = uuid();
            if (ipykernelCommand && ipykernelCommand.command) {
                const result = await ipykernelCommand.command.exec(['install', '--user', '--name', name, '--display-name', `'${displayName}'`], { throwOnStdErr: true, encoding: 'utf8', token: cancelToken });

                // Result should have our file name.
                const match = RegExpValues.PyKernelOutputRegEx.exec(result.stdout);
                const diskPath = match && match !== null && match.length > 1 ? path.join(match[1], 'kernel.json') : await this.findSpecPath(name);

                // Make sure we delete this file at some point. When we close VS code is probably good. It will also be destroy when
                // the kernel spec goes away
                this.asyncRegistry.push({
                    dispose: async () => {
                        if (!diskPath) {
                            return;
                        }
                        try {
                            await this.fileSystem.deleteDirectory(path.dirname(diskPath));
                        } catch {
                            noop();
                        }
                    }
                });

                // If that works, rewrite our active interpreter into the argv
                if (diskPath && bestInterpreter) {
                    if (await this.fileSystem.fileExists(diskPath)) {
                        const specModel: Kernel.ISpecModel = JSON.parse(await this.fileSystem.readFile(diskPath));
                        specModel.argv[0] = bestInterpreter.path;
                        await this.fileSystem.writeFile(diskPath, JSON.stringify(specModel), { flag: 'w', encoding: 'utf8' });
                    }
                }
            }
        } catch (err) {
            this.logger.logError(err);
        }
    }

    private findSpecPath = async (specName: string, cancelToken?: CancellationToken): Promise<string | undefined> => {
        // Enumerate all specs and get path for the match
        const specs = await this.enumerateSpecs(cancelToken);
        const match = specs!
            .filter(s => s !== undefined)
            .find(s => {
                const js = s as JupyterKernelSpec;
                return js && js.name === specName;
            }) as JupyterKernelSpec;
        return match ? match.specFile : undefined;
    }

    private async generateTempDir(): Promise<TemporaryDirectory> {
        const resultDir = path.join(os.tmpdir(), uuid());
        await this.fileSystem.createDirectory(resultDir);

        return {
            path: resultDir,
            dispose: async () => {
                // Try ten times. Process may still be up and running.
                // We don't want to do async as async dispose means it may never finish and then we don't
                // delete
                let count = 0;
                while (count < 10) {
                    try {
                        await this.fileSystem.deleteDirectory(resultDir);
                        count = 10;
                    } catch {
                        count += 1;
                    }
                }
            }
        };
    }

    private isCommandSupported = async (command: JupyterCommands, cancelToken?: CancellationToken): Promise<boolean> => {
        // See if we can find the command
        try {
            const result = await this.findBestCommand(command, cancelToken);
            return result.command !== undefined;
        } catch (err) {
            this.logger.logWarning(err);
            return false;
        }
    }

    private hasSpecPathMatch = async (info: PythonInterpreter | undefined, cancelToken?: CancellationToken): Promise<boolean> => {
        if (info) {
            // Enumerate our specs
            const specs = await this.enumerateSpecs(cancelToken);

            // See if any of their paths match
            return specs.findIndex(s => {
                if (info && s && s.path) {
                    return this.fileSystem.arePathsSame(s.path, info.path);
                }
                return false;
            }) >= 0;
        }

        // If no active interpreter, just act like everything is okay as we can't find a new spec anyway
        return true;
    }

    private async getInterpreterDetailsFromProcess(baseProcessName: string): Promise<PythonInterpreter | undefined> {
        if (path.basename(baseProcessName) !== baseProcessName) {
            // This function should only be called with a non qualified path. We're using this
            // function to figure out the qualified path
            return undefined;
        }

        // Make sure it's python based
        if (!baseProcessName.toLocaleLowerCase().includes('python')) {
            return undefined;
        }

        try {
            // Create a new process service to use to execute this process
            const processService = await this.processServiceFactory.create();

            // Ask python for what path it's running at.
            const output = await processService.exec(baseProcessName, ['-c', 'import sys;print(sys.executable)'], { throwOnStdErr: true });
            const fullPath = output.stdout.trim();

            // Use this path to get the interpreter details.
            return this.interpreterService.getInterpreterDetails(fullPath);
        } catch {
            // Any failure, just assume this path is invalid.
            return undefined;
        }
    }

    //tslint:disable-next-line:cyclomatic-complexity
    private findSpecMatch = async (enumerator: () => Promise<(IJupyterKernelSpec | undefined)[]>): Promise<IJupyterKernelSpec | undefined> => {
        traceInfo('Searching for a kernelspec match');
        // Extract our current python information that the user has picked.
        // We'll match against this.
        const info = await this.interpreterService.getActiveInterpreter();
        let bestScore = 0;
        let bestSpec: IJupyterKernelSpec | undefined;

        // Then enumerate our specs
        const specs = await enumerator();

        // For each get its details as we will likely need them
        const specDetails = await Promise.all(specs.map(async s => {
            if (s && s.path && s.path.length > 0 && await this.fileSystem.fileExists(s.path)) {
                return this.interpreterService.getInterpreterDetails(s.path);
            }
            if (s && s.path && s.path.length > 0 && path.basename(s.path) === s.path) {
                // This means the s.path isn't fully qualified. Try figuring it out.
                return this.getInterpreterDetailsFromProcess(s.path);
            }
        }));

        for (let i = 0; specs && i < specs.length; i += 1) {
            const spec = specs[i];
            let score = 0;

            // First match on language. No point if not python.
            if (spec && spec.language && spec.language.toLocaleLowerCase() === 'python') {
                // Language match
                score += 1;

                // See if the path matches. Don't bother if the language doesn't.
                if (spec && spec.path && spec.path.length > 0 && info && spec.path === info.path) {
                    // Path match
                    score += 10;
                }

                // See if the version is the same
                if (info && info.version && specDetails[i]) {
                    const details = specDetails[i];
                    if (details && details.version) {
                        if (details.version.major === info.version.major) {
                            // Major version match
                            score += 4;

                            if (details.version.minor === info.version.minor) {
                                // Minor version match
                                score += 2;

                                if (details.version.patch === info.version.patch) {
                                    // Minor version match
                                    score += 1;
                                }
                            }
                        }
                    }
                } else if (info && info.version && spec && spec.path && spec.path.toLocaleLowerCase() === 'python' && spec.name) {
                    // This should be our current python.

                    // Search for a digit on the end of the name. It should match our major version
                    const match = /\D+(\d+)/.exec(spec.name);
                    if (match && match !== null && match.length > 0) {
                        // See if the version number matches
                        const nameVersion = parseInt(match[0], 10);
                        if (nameVersion && nameVersion === info.version.major) {
                            score += 4;
                        }
                    }
                }
            }

            // Update high score
            if (score > bestScore) {
                bestScore = score;
                bestSpec = spec;
            }
        }

        // If still not set, at least pick the first one
        if (!bestSpec && specs && specs.length > 0) {
            bestSpec = specs[0];
        }

        traceInfo(`Found kernelspec match ${bestSpec ? `${bestSpec.name}' '${bestSpec.path}` : 'undefined'}`);
        return bestSpec;
    }

    private async readSpec(kernelSpecOutputLine: string): Promise<JupyterKernelSpec | undefined> {
        const match = RegExpValues.KernelSpecOutputRegEx.exec(kernelSpecOutputLine);
        if (match && match !== null && match.length > 2) {
            // Second match should be our path to the kernel spec
            const file = path.join(match[2], 'kernel.json');
            try {
                if (await this.fileSystem.fileExists(file)) {
                    // Turn this into a IJupyterKernelSpec
                    const model = JSON.parse(await this.fileSystem.readFile(file));
                    model.name = match[1];
                    return new JupyterKernelSpec(model, file);
                }
            } catch {
                // Just return nothing if we can't parse.
            }
        }

        return undefined;
    }

    private enumerateSpecs = async (_cancelToken?: CancellationToken): Promise<(JupyterKernelSpec | undefined)[]> => {
        if (await this.isKernelSpecSupported()) {
            const kernelSpecCommand = await this.findBestCommand(JupyterCommands.KernelSpecCommand);

            if (kernelSpecCommand.command) {
                try {
                    traceInfo('Asking for kernelspecs from jupyter');

                    // Ask for our current list.
                    const list = await kernelSpecCommand.command.exec(['list'], { throwOnStdErr: true, encoding: 'utf8' });

                    traceInfo('Parsing kernelspecs from jupyter');

                    // This should give us back a key value pair we can parse
                    const lines = list.stdout.splitLines({ trim: false, removeEmptyEntries: true });

                    // Generate all of the promises at once
                    const promises = lines.map(l => this.readSpec(l));

                    traceInfo('Awaiting the read of kernelspecs from jupyter');

                    // Then let them run concurrently (they are file io)
                    const specs = await Promise.all(promises);

                    traceInfo('Returning kernelspecs from jupyter');
                    return specs!.filter(s => s);
                } catch {
                    // This is failing for some folks. In that case return nothing
                    return [];
                }
            }
        }

        return [];
    }
}
