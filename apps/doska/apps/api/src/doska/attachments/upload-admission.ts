import { HTTPException } from "hono/http-exception";
/** Single-instance pilot limit, keyed by verified subject, independent of sessions. */
export class AttachmentAdmission {
  private readonly subjects = new Set<string>();
  acquire(subject: string): () => void {
    if (this.subjects.size >= 2 || this.subjects.has(subject))
      throw new HTTPException(429, {
        message: "Attachment transfer limit reached",
      });
    this.subjects.add(subject);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.subjects.delete(subject);
    };
  }
}
