import type { ReactNode } from "react";

export function PageHeading({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: ReactNode;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="app-page-header">
      <div className="min-w-0 space-y-3">
        {eyebrow && <p className="app-eyebrow">{eyebrow}</p>}
        <h1 tabIndex={-1} className="app-page-title">
          {title}
        </h1>
        {description && <p className="app-page-description">{description}</p>}
      </div>
      {actions && <div className="app-page-actions">{actions}</div>}
    </header>
  );
}
