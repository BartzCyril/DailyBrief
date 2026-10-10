import { Field } from "@/components/Field";

export function validArticleLinkSelector(value: string): boolean {
  const selector = value.trim();
  if (!selector) return true;
  if (selector.length > 200) return false;
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

export function RssArticleLinkField({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field
      label="Sélecteur du lien vers l'article (facultatif)"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      maxLength={200}
      placeholder="a.accessToPrimaryDoc.primarydoc"
      hint="Si le lien RSS mène à une notice, ciblez la balise a du lien vers l'article. Le lien doit porter un attribut href. Laissez vide pour lire directement la page du flux."
    />
  );
}
