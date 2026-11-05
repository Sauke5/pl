import ReactMarkdown from "react-markdown";

/** Compact, non-interactive Markdown inside the card's open/drag button. */
export function DoskaTaskExcerpt({ value }: { value: string }) {
  return (
    <span className="doska-task-excerpt">
      <ReactMarkdown
        skipHtml
        allowedElements={["p", "strong", "em", "code", "br", "li"]}
        unwrapDisallowed
        components={{
          p: ({ children }) => (
            <span className="doska-excerpt-line">{children}</span>
          ),
          li: ({ children }) => (
            <span className="doska-excerpt-line">• {children}</span>
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    </span>
  );
}
