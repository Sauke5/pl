import { ArrowUpRight, Check, Sparkles, Wrench } from "lucide-react";
import "./release-notes.css";

export type ReleaseNotes = {
  version: string;
  title: string;
  summary: string;
  sections: {
    kind: "new" | "improved" | "fixed";
    items: { title: string; description: string }[];
  }[];
};

const sections = {
  new: { label: "Новое", icon: Sparkles },
  improved: { label: "Стало удобнее", icon: ArrowUpRight },
  fixed: { label: "Исправлено", icon: Wrench },
};

export function ReleaseNotesArticle({ notes }: { notes: ReleaseNotes }) {
  return (
    <article
      className="release-story"
      aria-label={`Что нового в PL ${notes.version}`}
    >
      <header className="release-story-intro">
        <h3>{notes.title}</h3>
        <p>{notes.summary}</p>
      </header>
      <div className="release-story-sections">
        {notes.sections.map((section) => {
          const { label, icon: Icon } = sections[section.kind];
          return (
            <section className="release-story-section" key={section.kind}>
              <h4>
                <Icon size={16} aria-hidden="true" />
                {label}
              </h4>
              <ul>
                {section.items.map((item, index) => (
                  <li key={index}>
                    <Check size={15} aria-hidden="true" />
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.description}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </article>
  );
}
