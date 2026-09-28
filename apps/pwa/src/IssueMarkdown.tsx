import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./issue-markdown.css";

/** Provider text remains untrusted: no raw HTML or executable URL schemes. */
export function IssueMarkdown({ body, issueUrl }: { body: string; issueUrl: string }) {
  return (
    <div className="issue-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => {
          const safe = defaultUrlTransform(url);
          if (!safe) return "";
          try {
            return new URL(safe, `${issueUrl}/`).href;
          } catch {
            return "";
          }
        }}
        components={{
          input: ({ checked }) => (
            <input
              type="checkbox"
              disabled
              checked={checked ?? false}
              aria-label={checked ? "Completed task" : "Incomplete task"}
            />
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}
