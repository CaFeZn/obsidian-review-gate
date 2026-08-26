declare module "obsidian" {
  export const getLanguage: (() => string) | undefined;
  export function setIcon(parent: HTMLElement, iconId: string): void;

  export interface EventRef {}

  export class TAbstractFile {
    vault: Vault;
    path: string;
    name: string;
    parent: TAbstractFile | null;
  }

  export class TFile extends TAbstractFile {
    stat: { ctime: number; mtime: number; size: number };
    extension: string;
    basename: string;
  }

  export interface DataAdapter {
    getBasePath?(): string;
    exists(vaultPath: string): Promise<boolean>;
    stat(vaultPath: string): Promise<{ type: "file" | "folder"; mtime: number } | null>;
    list(vaultPath: string): Promise<{
      files: string[];
      folders: string[];
    }>;
    read(vaultPath: string): Promise<string>;
    write(vaultPath: string, data: string): Promise<void>;
    mkdir(vaultPath: string): Promise<void>;
    rmdir(vaultPath: string, recursive: boolean): Promise<void>;
    remove(vaultPath: string): Promise<void>;
    rename(source: string, destination: string): Promise<void>;
  }

  export interface Vault {
    adapter: DataAdapter;
    configDir: string;
    getAbstractFileByPath(path: string): TAbstractFile | null;
    on(name: "modify" | "create" | "delete", callback: (file: TAbstractFile) => unknown): EventRef;
    on(
      name: "rename",
      callback: (file: TAbstractFile, oldPath: string) => unknown,
    ): EventRef;
  }

  export interface WorkspaceParent {}

  export interface Workspace {
    rootSplit: WorkspaceParent;
    iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void;
    getMostRecentLeaf(root?: WorkspaceParent): WorkspaceLeaf | null;
    setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean }): void;
    getLeavesOfType(type: string): WorkspaceLeaf[];
    getRightLeaf(create: boolean): WorkspaceLeaf | null;
    getLeaf(newLeaf: "tab"): WorkspaceLeaf;
    createLeafBySplit(
      leaf: WorkspaceLeaf,
      direction: "vertical" | "horizontal",
      before?: boolean,
    ): WorkspaceLeaf;
    revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
    on(
      name: "file-menu",
      callback: (menu: Menu, file: TAbstractFile) => unknown,
    ): EventRef;
  }

  export class Menu {
    addItem(callback: (item: MenuItem) => unknown): this;
  }

  export class MenuItem {
    setTitle(title: string): this;
    setIcon(icon: string): this;
    onClick(callback: () => unknown): this;
  }

  export interface App {
    vault: Vault;
    workspace: Workspace;
  }

  export interface ViewState {
    type: string;
    state?: Record<string, unknown>;
    active?: boolean;
  }

  export interface ViewStateResult {
    history: boolean;
  }

  export class WorkspaceLeaf {
    parent: WorkspaceParent;
    view: unknown;
    getContainer(): WorkspaceParent;
    open(view: ItemView): Promise<ItemView>;
    setViewState(state: ViewState): Promise<void>;
    getViewState(): ViewState;
    openFile(file: TFile): Promise<void>;
    updateHeader(): void;
    detach(): void;
  }

  export abstract class ItemView {
    protected readonly leaf: WorkspaceLeaf;
    readonly app: App;
    readonly containerEl: HTMLElement;
    readonly contentEl: HTMLElement;
    navigation: boolean;
    constructor(leaf: WorkspaceLeaf);
    abstract getViewType(): string;
    abstract getDisplayText(): string;
    getIcon(): string;
    getState(): Record<string, unknown>;
    setState(state: unknown, result: ViewStateResult): Promise<void>;
    addAction(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement;
    register(callback: () => unknown): void;
    onOpen(): Promise<void> | void;
    onClose(): Promise<void> | void;
  }

  export class MarkdownView extends ItemView {
    allowNoFile: boolean;
    file: TFile | null;
    editor: Editor;
    requestSave: () => void;
    getViewType(): string;
    getDisplayText(): string;
    getViewData(): string;
    setViewData(data: string, clear: boolean): void;
    save(clear?: boolean): Promise<void>;
    clear(): void;
  }

  export abstract class Editor {
    abstract getLine(line: number): string;
    abstract lastLine(): number;
    abstract setValue(content: string): void;
    abstract scrollIntoView(
      range: {
        from: { line: number; ch: number };
        to: { line: number; ch: number };
      },
      center?: boolean,
    ): void;
  }

  export interface Command {
    id: string;
    name: string;
    callback?: () => unknown;
  }

  export abstract class Plugin {
    readonly app: App;
    readonly manifest: { id: string; version: string };
    registerView(type: string, creator: (leaf: WorkspaceLeaf) => ItemView): void;
    registerEditorExtension(extension: unknown): void;
    addRibbonIcon(icon: string, title: string, callback: () => unknown): HTMLElement;
    addCommand(command: Command): void;
    registerEvent(event: EventRef): void;
    register(callback: () => unknown): void;
    onload(): Promise<void> | void;
    onunload(): Promise<void> | void;
  }

  export class Modal {
    readonly app: App;
    readonly contentEl: HTMLElement;
    readonly titleEl: HTMLElement;
    constructor(app: App);
    setTitle(title: string): this;
    open(): void;
    close(): void;
    onOpen(): Promise<void> | void;
    onClose(): Promise<void> | void;
  }

  export class Notice {
    constructor(message: string, timeout?: number);
  }
}

interface HTMLElement {
    empty(): void;
    createDiv(options?: string | { cls?: string; text?: string }): HTMLDivElement;
    createSpan(options?: string | { cls?: string; text?: string }): HTMLSpanElement;
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      options?: { cls?: string; text?: string; type?: string; attr?: Record<string, string> },
    ): HTMLElementTagNameMap[K];
    addClass(...classes: string[]): void;
    removeClass(...classes: string[]): void;
    toggleClass(cls: string, value: boolean): void;
}
