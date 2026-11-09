export class ValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ValidationError';
    this.code = code;
  }
}
