import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AuthPage } from "./pages/AuthPage";
import { DashboardPage } from "./pages/DashboardPage";
import { NewSourcePage } from "./pages/NewSourcePage";
export function App() { return <AuthProvider><Routes><Route path="/login" element={<AuthPage/>}/><Route path="/register" element={<AuthPage register/>}/><Route element={<ProtectedRoute/>}><Route path="/dashboard" element={<DashboardPage/>}/><Route path="/sources/new/rss" element={<NewSourcePage/>}/></Route><Route path="*" element={<Navigate to="/dashboard" replace/>}/></Routes></AuthProvider>; }
