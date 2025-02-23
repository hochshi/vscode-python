// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../common/extensions';

import { Kernel } from '@jupyterlab/services';
import { JSONObject } from '@phosphor/coreutils';
import { inject, injectable, multiInject, optional } from 'inversify';
import { URL } from 'url';
import * as vscode from 'vscode';

import { CancellationTokenSource } from 'vscode-jsonrpc';
import { IApplicationShell, ICommandManager, IDebugService, IDocumentManager, IWorkspaceService } from '../common/application/types';
import { PYTHON_ALLFILES, PYTHON_LANGUAGE } from '../common/constants';
import { ContextKey } from '../common/contextKey';
import { traceError, traceInfo } from '../common/logger';
import {
    BANNER_NAME_DS_SURVEY,
    IConfigurationService,
    IDisposable,
    IDisposableRegistry,
    IExtensionContext,
    IPythonExtensionBanner
} from '../common/types';
import { debounceAsync } from '../common/utils/decorators';
import * as localize from '../common/utils/localize';
import { IServiceContainer } from '../ioc/types';
import { captureTelemetry, sendTelemetryEvent } from '../telemetry';
import { hasCells } from './cellFactory';
import { Commands, DefaultKernels, DefaultServers, EditorContexts, Settings, ShutdownOptions, Telemetry } from './constants';
import { createConnectionInfo } from './jupyter/jupyterUtils';
import { ICodeWatcher, IDataScience, IDataScienceCodeLensProvider, IDataScienceCommandListener, IJupyterKernelSpec, IJupyterServer, IJupyterServerQuickPickItem, IJupyterSessionManager, IJupyterSessionManagerFactory, IKernelQuickPickItem, INotebookEditorProvider, IStatusProvider } from './types';

@injectable()
export class DataScience implements IDataScience {
    public isDisposed: boolean = false;
    private readonly dataScienceSurveyBanner: IPythonExtensionBanner;
    private changeHandler: IDisposable | undefined;
    private startTime: number = Date.now();
    constructor(@inject(IServiceContainer) private serviceContainer: IServiceContainer,
        @inject(ICommandManager) private commandManager: ICommandManager,
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(IExtensionContext) private extensionContext: IExtensionContext,
        @inject(IDataScienceCodeLensProvider) private dataScienceCodeLensProvider: IDataScienceCodeLensProvider,
        @inject(IConfigurationService) private configuration: IConfigurationService,
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(IApplicationShell) private appShell: IApplicationShell,
        @inject(IWorkspaceService) private workspace: IWorkspaceService,
        @multiInject(IDataScienceCommandListener) @optional() private commandListeners: IDataScienceCommandListener[] | undefined,
        @inject(INotebookEditorProvider) private notebookProvider: INotebookEditorProvider,
        @inject(IDebugService) private debugService: IDebugService,
        @inject(IStatusProvider) private statusProvider: IStatusProvider,
        @inject(IJupyterSessionManagerFactory) private sessionManagerFactory: IJupyterSessionManagerFactory
    ) {
        this.dataScienceSurveyBanner = this.serviceContainer.get<IPythonExtensionBanner>(IPythonExtensionBanner, BANNER_NAME_DS_SURVEY);
    }

    public get activationStartTime(): number {
        return this.startTime;
    }

    public async activate(): Promise<void> {
        this.registerCommands();

        this.extensionContext.subscriptions.push(
            vscode.languages.registerCodeLensProvider(
                PYTHON_ALLFILES, this.dataScienceCodeLensProvider
            )
        );

        // Set our initial settings and sign up for changes
        this.onSettingsChanged();
        this.changeHandler = this.configuration.getSettings().onDidChange(this.onSettingsChanged.bind(this));
        this.disposableRegistry.push(this);

        // Listen for active editor changes so we can detect have code cells or not
        this.disposableRegistry.push(this.documentManager.onDidChangeActiveTextEditor(() => this.onChangedActiveTextEditor()));
        this.onChangedActiveTextEditor();

        // Send telemetry for all of our settings
        this.sendSettingsTelemetry().ignoreErrors();
    }

    public async dispose() {
        if (this.changeHandler) {
            this.changeHandler.dispose();
            this.changeHandler = undefined;
        }
    }

    public async runFileInteractive(file: string): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.runFileInteractive();
        } else {
            return Promise.resolve();
        }
    }

    public async debugFileInteractive(file: string): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.debugFileInteractive();
        } else {
            return Promise.resolve();
        }
    }

    public async runAllCells(file: string): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.runAllCells();
        } else {
            return Promise.resolve();
        }
    }

    // Note: see codewatcher.ts where the runcell command args are attached. The reason we don't have any
    // objects for parameters is because they can't be recreated when passing them through the LiveShare API
    public async runCell(file: string, startLine: number, startChar: number, endLine: number, endChar: number): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();
        const codeWatcher = this.getCodeWatcher(file);
        if (codeWatcher) {
            return codeWatcher.runCell(new vscode.Range(startLine, startChar, endLine, endChar));
        }
    }

    public async runAllCellsAbove(file: string, stopLine: number, stopCharacter: number): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.runAllCellsAbove(stopLine, stopCharacter);
            }
        }
    }

    public async runCellAndAllBelow(file: string, startLine: number, startCharacter: number): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.runCellAndAllBelow(startLine, startCharacter);
            }
        }
    }

    public async runToLine(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const activeCodeWatcher = this.getCurrentCodeWatcher();
        const textEditor = this.documentManager.activeTextEditor;

        if (activeCodeWatcher && textEditor && textEditor.selection) {
            return activeCodeWatcher.runToLine(textEditor.selection.start.line);
        }
    }

    public async runFromLine(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const activeCodeWatcher = this.getCurrentCodeWatcher();
        const textEditor = this.documentManager.activeTextEditor;

        if (activeCodeWatcher && textEditor && textEditor.selection) {
            return activeCodeWatcher.runFromLine(textEditor.selection.start.line);
        }
    }

    public async runCurrentCell(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runCurrentCell();
        } else {
            return Promise.resolve();
        }
    }

    public async runCurrentCellAndAdvance(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runCurrentCellAndAdvance();
        } else {
            return Promise.resolve();
        }
    }

    // tslint:disable-next-line:no-any
    public async runSelectionOrLine(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runSelectionOrLine(this.documentManager.activeTextEditor);
        } else {
            return Promise.resolve();
        }
    }

    @captureTelemetry(Telemetry.SelectJupyterURI)
    public async selectJupyterURI(): Promise<void> {
        const quickPickOptions = this.populateServerOptions();
        const selection = await this.appShell.showQuickPick(quickPickOptions, { ignoreFocusOut: true });

        // If user cancels quick pick we will get undefined and return
        if (!selection) {
            return;
        }
        switch (selection.label) {
            case localize.DataScience.jupyterSelectURILaunchLocal():
                return this.setJupyterURIToLocal();
                break;
            case localize.DataScience.jupyterSelectURISpecifyURI():
                await this.selectJupyterLaunchURI();
                break;
            default:
                // The user selected an existing server
                await this.setJupyterURIToSelection(selection);
                break;
        }
    }

    public async debugCell(file: string, startLine: number, startChar: number, endLine: number, endChar: number): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.debugCell(new vscode.Range(startLine, startChar, endLine, endChar));
            }
        }
    }

    @captureTelemetry(Telemetry.DebugStepOver)
    public async debugStepOver(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            this.commandManager.executeCommand('workbench.action.debug.stepOver');
        }
    }

    @captureTelemetry(Telemetry.DebugStop)
    public async debugStop(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            this.commandManager.executeCommand('workbench.action.debug.stop');
        }
    }

    @captureTelemetry(Telemetry.DebugContinue)
    public async debugContinue(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            this.commandManager.executeCommand('workbench.action.debug.continue');
        }
    }

    @captureTelemetry(Telemetry.SetJupyterURIToLocal)
    private async setJupyterURIToLocal(): Promise<void> {
        await this.configuration.updateSetting('dataScience.jupyterServerURI', Settings.JupyterServerLocalLaunch, undefined, vscode.ConfigurationTarget.Workspace);
        await this.configuration.updateSetting('dataScience.jupyterServerKernelSpec', undefined, undefined, vscode.ConfigurationTarget.Workspace);
        await this.configuration.updateSetting('dataScience.jupyterServerAllowKernelShutdown', undefined, undefined, vscode.ConfigurationTarget.Workspace);
    }

    @captureTelemetry(Telemetry.SetJupyterURIToUserSpecified)
    private async selectJupyterLaunchURI(): Promise<void> {
        // First get the proposed URI from the user
        const userURI = await this.appShell.showInputBox({
            prompt: localize.DataScience.jupyterSelectURIPrompt(),
            placeHolder: 'https://hostname:8080/?token=849d61a414abafab97bc4aab1f3547755ddc232c2b8cb7fe', validateInput: this.validateURI, ignoreFocusOut: true
        });

        if (userURI) {
            await this.configuration.updateSetting('dataScience.jupyterServerURI', userURI, undefined, vscode.ConfigurationTarget.Workspace);
            await this.selectRemoteJupyterKernel();
        }
    }

    @captureTelemetry(Telemetry.SetJupyterURIToUserSelection)
    private async setJupyterURIToSelection(selection: IJupyterServerQuickPickItem): Promise<void> {
        // First get the proposed URI from the user
        await this.configuration.updateSetting('dataScience.jupyterServerURI', selection.uri, undefined, vscode.ConfigurationTarget.Workspace);
        await this.selectRemoteJupyterKernel();
    }

    private async getRunningJupyterKernels(sessionManager: IJupyterSessionManager, cancelSource: CancellationTokenSource): Promise<IKernelQuickPickItem[] | undefined> {
        try {
            const runningKernels: Kernel.IModel[] = await this.waitForStatus(() => {
                return sessionManager.getRunningKernels();
            }, localize.DataScience.jupyterGetRunningKernels().format(sessionManager.getConnInfo().hostName),
                cancelSource);
            const arr: IKernelQuickPickItem[] = runningKernels.map(runningKernel => {
                traceInfo(`Found running kernel ${runningKernel.id}, running since ${runningKernel.last_activity}`);
                const localLastActivity = runningKernel.last_activity ? new Date(runningKernel.last_activity.toString()).toLocaleString() : '?';
                const localConnections = runningKernel.connections === undefined || runningKernel.connections === null ? '?' : runningKernel.connections.toString();
                return {
                    label: localize.DataScience.runningKernelLabel().format(runningKernel.name, runningKernel.id),
                    detail: localize.DataScience.runningKernelDetail().format(localLastActivity, localConnections),
                    kernelId: runningKernel.id,
                    name: runningKernel.name
                };
            });
            arr.unshift(DefaultKernels.newKernel);
            return arr;
        } catch (err) {
            traceInfo('Failed getting running remote jupyter kernels with error', err);
            return undefined;
        }
    }

    private async getActiveJupyterKernels(sessionManager: IJupyterSessionManager, cancelSource: CancellationTokenSource): Promise<IJupyterKernelSpec[] | undefined> {
        // This function is practicly a neccesity as sessionManager.getActiveKernelSpecs catchs all exceptions
        // and returns an empty array instead of undfined when an exception occurs. This is inconsistent with
        // the desired behaviour.
        try {
            const kernelSpecs: IJupyterKernelSpec[] = await this.waitForStatus(
                () => { return sessionManager.getActiveKernelSpecs(); },
                localize.DataScience.jupyterGetAvailableKernels().format(sessionManager.getConnInfo().hostName),
                cancelSource
            );
            if (kernelSpecs && kernelSpecs.length) {
                return kernelSpecs;
            }
            return undefined;
        } catch (err) {
            traceInfo('Failed getting running remote jupyter kernels with error', err);
            return undefined;
        }
    }

    private async getQuickPickKernelSelection(kernelOptions: IKernelQuickPickItem[]): Promise<IKernelQuickPickItem | undefined> {
        return this.appShell.showQuickPick(kernelOptions, {
            ignoreFocusOut: true,
            placeHolder: localize.DataScience.jupyterServerReconnectKernelLocal()
        });
    }

    private async getKernelSpecQuickPickSelection(kernelSpecs: IJupyterKernelSpec[]): Promise<IKernelQuickPickItem | undefined> {
        const availArr: IKernelQuickPickItem[] = kernelSpecs.map(availableKernel => {
            return {
                label: localize.DataScience.availableKernelLabel().format(availableKernel.name),
                detail: '',
                kernelId: '',
                name: availableKernel.name
            };
        });
        return this.getQuickPickKernelSelection(availArr);
    }

    @captureTelemetry(Telemetry.JupyterKernelSpecified)
    private async setRemoteJupterKernel(kernelSelection: IKernelQuickPickItem, kernelSpecs: IJupyterKernelSpec[]): Promise<void> {

        let kernelUUID: string | undefined;
        let kernelName: string | undefined;
        let kernelSpec: IJupyterKernelSpec | undefined;

        if (kernelSelection !== DefaultKernels.newKernel) {
            traceInfo(`Will connect to existing kernel ${kernelSelection.kernelId}`);
            sendTelemetryEvent(Telemetry.JupyterKernelSpecified);
        }

        kernelUUID = kernelSelection.kernelId ? kernelSelection.kernelId : undefined;
        kernelName = kernelSelection.name ? kernelSelection.name : undefined;
        const matchingKernelSpecs = kernelSpecs.filter(spec => spec.name === kernelName);
        // Take first matching kernel spec - in the future we might want to throw an error or let the user re-select
        kernelSpec = matchingKernelSpecs.length === 1 ? matchingKernelSpecs[0] : undefined;

        if (kernelSpec) {
            kernelSpec.id = kernelUUID;
        }

        await this.configuration.updateSetting('dataScience.jupyterServerKernelSpec', kernelSpec, undefined, vscode.ConfigurationTarget.Workspace);
    }

    @captureTelemetry(Telemetry.SelectJupyterKernel)
    private async selectRemoteJupyterKernel(): Promise<void> {

        const settings = this.configuration.getSettings();

        const cancelSource = new CancellationTokenSource();
        const connInfo = createConnectionInfo(settings.datascience.jupyterServerURI, settings);
        const sessionManager = await this.sessionManagerFactory.create(connInfo);
        try {
            // Get available kernel specs from remote in the background allowing the user to cancel
            const kernelSpecsPromise: Promise<IJupyterKernelSpec[] | undefined> = this.getActiveJupyterKernels(sessionManager, cancelSource);

            // Get running remote kernels allowing the user to cancel
            const remoteRunningKernels: IKernelQuickPickItem[] | undefined = await this.getRunningJupyterKernels(sessionManager, cancelSource);
            if (!remoteRunningKernels) {
                if (cancelSource.token.isCancellationRequested) {
                    traceInfo('User cancelled getting running remote kernels.');
                } else {
                    this.appShell.showErrorMessage(localize.DataScience.jupyterNoRunningKernels().format(connInfo.hostName));
                }
                return;
            }

            let kernelSelection: IKernelQuickPickItem | undefined = await this.getQuickPickKernelSelection(remoteRunningKernels);

            const kernelSpecs: IJupyterKernelSpec[] | undefined = await kernelSpecsPromise;
            if (!kernelSpecs) {
                if (cancelSource.token.isCancellationRequested) {
                    traceInfo('User cancelled getting available remote kernels.');
                } else {
                    this.appShell.showErrorMessage(localize.DataScience.jupyterNoAvailableKernels().format(connInfo.hostName));
                }
                return;
            }

            if (kernelSelection === DefaultKernels.newKernel) {
                traceInfo('Will create a new kernel for connection');
                kernelSelection = await this.getKernelSpecQuickPickSelection(kernelSpecs);
            }

            if (!kernelSelection) {
                traceInfo('User cancelled selecting a kernel.');
                return;
            }

            const allowShutdown = this.selectJupyterKernelAutoShutdown();

            await this.setRemoteJupterKernel(kernelSelection, kernelSpecs);
            await allowShutdown;
        } finally {
            cancelSource.dispose();
            await sessionManager.dispose();
        }
    }

    @captureTelemetry(Telemetry.JupyterKernelAutoShutdown, { autoShutdownEnabled: true })
    private async selectJupyterKernelAutoShutdown(): Promise<void> {
        let allowShutdown = true;
        const shutdownSelection = await this.appShell.showQuickPick(ShutdownOptions.options, { ignoreFocusOut: true });

        if (shutdownSelection && shutdownSelection.keepRunning) {
            traceInfo('Session will not be shutdown on close');
            allowShutdown = false;
        }
        await this.configuration.updateSetting('dataScience.jupyterServerAllowKernelShutdown', allowShutdown, undefined, vscode.ConfigurationTarget.Workspace);
    }

    private async waitForStatus<T>(promise: () => Promise<T>, message: string, cancelSource: CancellationTokenSource, canceled?: (() => void)): Promise<T> {
        canceled = canceled ? canceled : () => {
            cancelSource.cancel();
        };
        return this.statusProvider.waitWithStatus(promise, message, undefined, canceled);
    }

    @captureTelemetry(Telemetry.AddCellBelow)
    private async addCellBelow(): Promise<void> {
        const activeEditor = this.documentManager.activeTextEditor;
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeEditor && activeCodeWatcher) {
            return activeCodeWatcher.addEmptyCellToBottom();
        }
    }

    private async runCurrentCellAndAddBelow(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runCurrentCellAndAddBelow();
        } else {
            return Promise.resolve();
        }
    }

    private getCurrentCodeLens(): vscode.CodeLens | undefined {
        const activeEditor = this.documentManager.activeTextEditor;
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeEditor && activeCodeWatcher) {
            // Find the cell that matches
            return activeCodeWatcher.getCodeLenses().find((c: vscode.CodeLens) => {
                if (c.range.end.line >= activeEditor.selection.anchor.line &&
                    c.range.start.line <= activeEditor.selection.anchor.line) {
                    return true;
                }
                return false;
            });
        }
    }

    private async runAllCellsAboveFromCursor(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.runAllCellsAbove(currentCodeLens.range.start.line, currentCodeLens.range.start.character);
            }
        } else {
            return Promise.resolve();
        }
    }

    private async runCellAndAllBelowFromCursor(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.runCellAndAllBelow(currentCodeLens.range.start.line, currentCodeLens.range.start.character);
            }
        } else {
            return Promise.resolve();
        }
    }

    private async debugCurrentCellFromCursor(): Promise<void> {
        this.dataScienceSurveyBanner.showBanner().ignoreErrors();

        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.debugCurrentCell();
            }
        } else {
            return Promise.resolve();
        }
    }

    private validateURI = (testURI: string): string | undefined | null => {
        try {
            // tslint:disable-next-line:no-unused-expression
            new URL(testURI);
        } catch {
            return localize.DataScience.jupyterSelectURIInvalidURI();
        }

        // Return null tells the dialog that our string is valid
        return null;
    }

    private onSettingsChanged = () => {
        const settings = this.configuration.getSettings();
        const enabled = settings.datascience.enabled;
        let editorContext = new ContextKey(EditorContexts.DataScienceEnabled, this.commandManager);
        editorContext.set(enabled).catch();
        const ownsSelection = settings.datascience.sendSelectionToInteractiveWindow;
        editorContext = new ContextKey(EditorContexts.OwnsSelection, this.commandManager);
        editorContext.set(ownsSelection && enabled).catch();
    }

    private getCodeWatcher(file: string): ICodeWatcher | undefined {
        const possibleDocuments = this.documentManager.textDocuments.filter(d => d.fileName === file);
        if (possibleDocuments && possibleDocuments.length === 1) {
            return this.dataScienceCodeLensProvider.getCodeWatcher(possibleDocuments[0]);
        } else if (possibleDocuments && possibleDocuments.length > 1) {
            throw new Error(localize.DataScience.documentMismatch().format(file));
        }

        return undefined;
    }

    // Get our matching code watcher for the active document
    private getCurrentCodeWatcher(): ICodeWatcher | undefined {
        const activeEditor = this.documentManager.activeTextEditor;
        if (!activeEditor || !activeEditor.document) {
            return undefined;
        }

        // Ask our code lens provider to find the matching code watcher for the current document
        return this.dataScienceCodeLensProvider.getCodeWatcher(activeEditor.document);
    }

    private registerCommands(): void {
        let disposable = this.commandManager.registerCommand(Commands.RunAllCells, this.runAllCells, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunCell, this.runCell, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunCurrentCell, this.runCurrentCell, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunCurrentCellAdvance, this.runCurrentCellAndAdvance, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.ExecSelectionInInteractiveWindow, this.runSelectionOrLine, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.SelectJupyterURI, this.selectJupyterURI, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunAllCellsAbove, this.runAllCellsAbove, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunCellAndAllBelow, this.runCellAndAllBelow, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunAllCellsAbovePalette, this.runAllCellsAboveFromCursor, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunCellAndAllBelowPalette, this.runCellAndAllBelowFromCursor, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunToLine, this.runToLine, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunFromLine, this.runFromLine, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunFileInInteractiveWindows, this.runFileInteractive, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.DebugFileInInteractiveWindows, this.debugFileInteractive, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.AddCellBelow, this.addCellBelow, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.RunCurrentCellAndAddBelow, this.runCurrentCellAndAddBelow, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.DebugCell, this.debugCell, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.DebugStepOver, this.debugStepOver, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.DebugContinue, this.debugContinue, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.DebugStop, this.debugStop, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.DebugCurrentCellPalette, this.debugCurrentCellFromCursor, this);
        this.disposableRegistry.push(disposable);
        disposable = this.commandManager.registerCommand(Commands.CreateNewNotebook, this.createNewNotebook, this);
        this.disposableRegistry.push(disposable);
        if (this.commandListeners) {
            this.commandListeners.forEach((listener: IDataScienceCommandListener) => {
                listener.register(this.commandManager);
            });
        }
    }

    private onChangedActiveTextEditor() {
        // Setup the editor context for the cells
        const editorContext = new ContextKey(EditorContexts.HasCodeCells, this.commandManager);
        const activeEditor = this.documentManager.activeTextEditor;

        if (activeEditor && activeEditor.document.languageId === PYTHON_LANGUAGE) {
            // Inform the editor context that we have cells, fire and forget is ok on the promise here
            // as we don't care to wait for this context to be set and we can't do anything if it fails
            editorContext.set(hasCells(activeEditor.document, this.configuration.getSettings().datascience)).catch();
        } else {
            editorContext.set(false).catch();
        }
    }

    @debounceAsync(1)
    private async sendSettingsTelemetry(): Promise<void> {
        try {
            // Get our current settings. This is what we want to send.
            // tslint:disable-next-line:no-any
            const settings = this.configuration.getSettings().datascience as any;

            // Translate all of the 'string' based settings into known values or not.
            const pythonConfig = this.workspace.getConfiguration('python');
            if (pythonConfig) {
                const keys = Object.keys(settings);
                const resultSettings: JSONObject = {};
                for (const k of keys) {
                    const currentValue = settings[k];
                    if (typeof currentValue === 'string') {
                        const inspectResult = pythonConfig.inspect<string>(`dataScience.${k}`);
                        if (inspectResult && inspectResult.defaultValue !== currentValue) {
                            resultSettings[k] = 'non-default';
                        } else {
                            resultSettings[k] = 'default';
                        }
                    } else {
                        resultSettings[k] = currentValue;
                    }
                }
                sendTelemetryEvent(Telemetry.DataScienceSettings, 0, resultSettings);
            }
        } catch (err) {
            traceError(err);
        }
    }

    private async createNewNotebook(): Promise<void> {
        await this.notebookProvider.createNew();
    }

    private populateServerOptions(): IJupyterServerQuickPickItem[] {
        const settings = this.configuration.getSettings();

        const jupyterServers: IJupyterServer[] | undefined = settings.datascience.jupyterServers;
        let optionsArr: IJupyterServerQuickPickItem[] = [];
        if (jupyterServers) {
            optionsArr = jupyterServers.map(server => {
                traceInfo(`Found server ${server.hostName}, with uri ${server.uri}`);
                return {
                    label: server.hostName,
                    hostName: server.hostName,
                    uri: server.uri
                };
            });
        }

        optionsArr.unshift(DefaultServers.localJupyter);
        optionsArr.push(DefaultServers.specifyJupyter);
        return optionsArr;
    }
}
