export type ProgressLevel = "info" | "detail";

export type ProgressHandler = (level: ProgressLevel, message: string) => void;

export function reportProgress(progress: ProgressHandler | undefined, message: string): void {
  progress?.("info", message);
}

export function reportProgressDetail(progress: ProgressHandler | undefined, message: string): void {
  progress?.("detail", message);
}
