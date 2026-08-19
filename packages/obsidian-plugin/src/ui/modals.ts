import { App, Modal, Notice } from "obsidian";
import { tryCreateMergeEditor, type MergeEditorController, type MergeEditorMode } from "../editor/cm6-adapter";

export class ProposalEditModal extends Modal {
  private value: string;
  private controller: MergeEditorController | null = null;
  private textarea: HTMLTextAreaElement | null = null;

  public constructor(
    app: App,
    private readonly base: string,
    initial: string,
    private readonly mode: MergeEditorMode,
    private readonly onSave: (value: string) => Promise<void>,
  ) {
    super(app);
    this.value = initial;
  }

  public override onOpen(): void {
    this.setTitle("Edit proposal (target remains unchanged)");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      cls: "obsreview-modal-note",
      text: "Saving updates only .obsreview proposal state. The target file is written only by Approve.",
    });
    const editorHost = this.contentEl.createDiv({ cls: "obsreview-proposal-editor" });
    this.controller = tryCreateMergeEditor(
      editorHost,
      this.base,
      this.value,
      this.mode,
      (value) => {
        this.value = value;
      },
    );
    if (this.controller === null) {
      const textarea = editorHost.createEl("textarea", {
        cls: "obsreview-proposal-textarea",
      });
      this.textarea = textarea;
      textarea.value = this.value;
      textarea.addEventListener("input", () => {
        this.value = textarea.value;
      });
    }

    const actions = this.contentEl.createDiv({ cls: "obsreview-modal-actions" });
    const save = actions.createEl("button", { text: "Save proposal", cls: "mod-cta" });
    save.addEventListener("click", () => void this.save());
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  public override onClose(): void {
    this.controller?.destroy();
    this.controller = null;
    this.textarea = null;
    this.contentEl.empty();
  }

  private async save(): Promise<void> {
    const value = this.controller?.getProposal() ?? this.textarea?.value ?? this.value;
    try {
      await this.onSave(value);
      this.close();
    } catch (error) {
      new Notice(`Could not save proposal: ${message(error)}`);
    }
  }
}

export class ConfirmActionModal extends Modal {
  public constructor(
    app: App,
    private readonly title: string,
    private readonly explanation: string,
    private readonly confirmationText: string,
    private readonly dangerous: boolean,
    private readonly action: () => Promise<void>,
  ) {
    super(app);
  }

  public override onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.explanation });
    const actions = this.contentEl.createDiv({ cls: "obsreview-modal-actions" });
    const confirm = actions.createEl("button", {
      text: this.confirmationText,
      cls: this.dangerous ? "mod-warning" : "mod-cta",
    });
    confirm.addEventListener("click", () => void this.run());
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  private async run(): Promise<void> {
    try {
      await this.action();
      this.close();
    } catch (error) {
      new Notice(`Action failed: ${message(error)}`);
    }
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
