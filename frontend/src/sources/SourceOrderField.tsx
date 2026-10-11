import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function SourceOrderField({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
      <div className="min-w-0 space-y-2">
        <Label htmlFor={id}>Articles du plus récent au plus ancien</Label>
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          Activez uniquement si cet ordre est garanti, pour arrêter la collecte avant les archives.
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
      />
    </div>
  );
}
