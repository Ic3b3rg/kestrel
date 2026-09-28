import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown-content.css";

/** Markdown remains untrusted: no raw HTML or executable URL schemes. */
export function MarkdownContent({ body, baseUrl }: { body: string; baseUrl?: string }) {
  return (
    <div className="markdown-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => {
          const safe = defaultUrlTransform(url);
          if (!safe) return "";
          if (baseUrl === undefined) return safe;
          try {
            return new URL(safe, baseUrl).href;
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
