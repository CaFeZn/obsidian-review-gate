declare module "obsidian" {
  export interface EventRef {}

  export class TAbstractFile {
    path: string;
  }

  export class TFile extends TAbstractFile {
    extension: string;
    basename: string;
  }

  export interface DataAdapter {
    getBasePath?(): string;
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

  export interface Workspace {
    getLeavesOfType(type: string): WorkspaceLeaf[];
    getRightLeaf(create: boolean): WorkspaceLeaf | null;
    getLeaf(newLeaf?: boolean): WorkspaceLeaf;
    revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
  }

  export interface App {
    vault: Vault;
    workspace: Workspace;
  }

  export class WorkspaceLeaf {
    view: unknown;
    setViewState(state: { type: string; active?: boolean }): Promise<void>;
    openFile(file: TFile): Promise<void>;
  }

  export abstract class ItemView {
    protected readonly leaf: WorkspaceLeaf;
    readonly app: App;
    readonly containerEl: HTMLElement;
    readonly contentEl: HTMLElement;
    constructor(leaf: WorkspaceLeaf);
    abstract getViewType(): string;
    abstract getDisplayText(): string;
    getIcon(): string;
    onOpen(): Promise<void> | void;
    onClose(): Promise<void> | void;
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
