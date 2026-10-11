import { Link } from "react-router-dom";
import { Mail } from "lucide-react";

export function Brand({
  to = "/",
  label = "DailyBrief, accueil",
}: {
  to?: string;
  label?: string;
}) {
  return (
    <Link to={to} className="brand-mark" aria-label={label}>
      <span className="brand-symbol">
        <Mail aria-hidden="true" size={21} />
      </span>
      DailyBrief<span className="brand-dot">.</span>
    </Link>
  );
}
