export enum ExitCode {
  Success = 0,
  GeneralError = 1,
  InvalidArguments = 2,
  WorkspaceError = 3,
  SourceError = 4,
  IngestionError = 5,
  IndexError = 6,
  QueryError = 7,
  ProviderError = 8
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode: ExitCode,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "CliError";
  }
}
