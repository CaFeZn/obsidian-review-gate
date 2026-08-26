import { App, Modal, Notice } from "obsidian";
import { localizeError, t } from "../i18n";

export interface ConfirmActionRequest {
  readonly title: string;
  readonly explanation: string;
  readonly confirmationText: string;
  readonly dangerous: boolean;
  readonly action: () => Promise<void>;
}

export class ConfirmActionModal extends Modal {
  public constructor(
    app: App,
    private readonly request: ConfirmActionRequest,
  ) {
    super(app);
  }

  public override onOpen(): void {
    this.setTitle(this.request.title);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.request.explanation });
    const actions = this.contentEl.createDiv({ cls: "obsreview-modal-actions" });
    const confirm = actions.createEl("button", {
      text: this.request.confirmationText,
      cls: this.request.dangerous ? "mod-warning" : "mod-cta",
    });
    confirm.addEventListener("click", () => void this.run());
    const cancel = actions.createEl("button", { text: t("cancel") });
    cancel.addEventListener("click", () => this.close());
  }

  private async run(): Promise<void> {
    try {
      await this.request.action();
      this.close();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      new Notice(t("actionFailed", { error: message(error) }));
    }
  }
}

export function message(error: unknown): string {
  return localizeError(error);
}
