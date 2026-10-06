import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Mail, LoaderCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import { Feedback } from "@/components/Feedback";
import { useAuth } from "@/auth/AuthProvider";
import { authApi } from "@/auth/api";
import { errorMessage } from "@/lib/api";
export function AuthPage({ register = false }: { register?: boolean }) {
  const auth = useAuth(); const navigate = useNavigate();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [success, setSuccess] = useState("");
  if (auth.user) return <Navigate to="/dashboard" replace/>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setError(""); setSuccess("");
    if (register && (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password))) { setError("Utilisez au moins 12 caractères, une majuscule, une minuscule et un chiffre."); return; }
    if (register && password !== confirmation) { setError("Les mots de passe ne correspondent pas."); return; }
    setBusy(true);
    try { if (register) { await authApi.register(email, password); setPassword(""); setConfirmation(""); setSuccess("Compte créé. Vous pouvez vous connecter."); } else { await auth.login(email, password); navigate("/dashboard", { replace: true }); } }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <main className="min-h-screen grid lg:grid-cols-2"><section className="hidden lg:flex bg-primary text-primary-foreground flex-col justify-between p-16"><div className="flex gap-3 items-center text-2xl font-semibold"><Mail/> DailyBrief</div><div><p className="text-sm uppercase tracking-widest opacity-70 mb-6">Votre veille, simplement</p><h1 className="text-5xl font-semibold leading-tight">L'essentiel de vos sources.<br/>Chaque matin.</h1><p className="mt-6 text-lg opacity-80 max-w-md">Rassemblez les sujets qui vous intéressent et recevez un résumé clair dans votre boîte mail.</p></div><p className="text-sm opacity-60">Moins de bruit. Plus de perspective.</p></section><section className="flex items-center justify-center p-6"><Card className="w-full max-w-md border-0 shadow-none bg-transparent"><CardHeader><p className="text-primary font-semibold mb-4 lg:hidden">DailyBrief</p><CardTitle className="text-3xl">{register ? "Créer votre compte" : "Bienvenue"}</CardTitle><CardDescription>{register ? "Préparez votre première veille quotidienne." : "Connectez-vous pour retrouver votre veille."}</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="space-y-5"><fieldset disabled={busy} className="space-y-5"><Field label="Email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)}/><Field label="Mot de passe" type="password" autoComplete={register ? "new-password" : "current-password"} required maxLength={128} value={password} onChange={event => setPassword(event.target.value)} hint={register ? "12 caractères, une majuscule, une minuscule et un chiffre." : undefined}/>{register && <Field label="Confirmer le mot de passe" type="password" autoComplete="new-password" required value={confirmation} onChange={event => setConfirmation(event.target.value)}/>}</fieldset><Feedback message={error} error/><Feedback message={success}/><Button className="w-full" disabled={busy || (register && !!success)} type="submit">{busy && <LoaderCircle className="animate-spin"/>}{busy ? "Veuillez patienter…" : register ? "Créer le compte" : "Se connecter"}</Button></form><p className="mt-6 text-sm text-muted-foreground">{register ? "Déjà un compte ?" : "Pas encore de compte ?"} <Link className="font-medium text-primary underline-offset-4 hover:underline" to={register ? "/login" : "/register"}>{register ? "Se connecter" : "S'inscrire"}</Link></p></CardContent></Card></section></main>;
}
