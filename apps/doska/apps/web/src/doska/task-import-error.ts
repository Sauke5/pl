export class TaskImportError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(code);
  }
  get row() {
    const path = this.issues.find((issue) =>
      /body\.tasks\.\d+/.test(issue.path),
    )?.path;
    const match = path?.match(/body\.tasks\.(\d+)/);
    return match ? Number(match[1]) + 1 : undefined;
  }
}
