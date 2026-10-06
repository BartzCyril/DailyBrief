import { useId } from "react";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
export function SelectField({ label, value, onChange, choices, disabled }: { label: string; value: string; onChange: (value: string) => void; choices: { value: string; label: string }[]; disabled?: boolean }) {
  const id = useId(); return <div className="grid gap-2"><Label htmlFor={id}>{label}</Label><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger id={id} className="w-full"><SelectValue/></SelectTrigger><SelectContent>{choices.map(choice => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectContent></Select></div>;
}
