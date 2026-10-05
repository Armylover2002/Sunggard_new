import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@core/context/AuthContext';
import { useSettings } from '@core/context/SettingsContext';
import { adminApi } from '../services/adminApi';
import {
    Caption,
    ConsignmentNote,
    DeliveryCode,
    DepotGround,
    NoteAction,
    NoteField,
    NotePane,
    NoteStub,
    RouteLeader,
    TearEdge,
    noteInput,
    stackIn,
    stackItem,
} from '@shared/components/auth/consignmentKit';
import { ADMIN_THEME_VARS, MONO } from '@shared/design/tokens';

/**
 * Admin sign-in, filed as a consignment note.
 *
 * design.md §9 listed this surface as unconverted; this is that conversion,
 * following the recipe there. The depot desk is reached through the same door
 * as everything else — the operator is filing a note too, and the note happens
 * to be their own credentials.
 *
 * Sign-in only: the first admin account is created through the secret-gated
 * POST /admin/bootstrap flow, not a public page — there is no "create admin"
 * path here for anyone who finds this URL to use.
 *
 * Forgot password is a 3-step note of its own (email -> OTP -> new password),
 * reusing the same stationery. The server only ever emails the OTP to the
 * address already on the admin account — there is no way to target someone
 * else's inbox from this form.
 */

const CODE_LENGTH = 4;
const RESEND_SECONDS = 30;

/** Mirrors the server's Joi passwordSchema in adminAuthValidation.js. */
const PASSWORD_RULES = [
    { test: (v) => v.length >= 10, label: 'At least 10 characters' },
    { test: (v) => /[a-z]/.test(v), label: 'One lowercase letter' },
    { test: (v) => /[A-Z]/.test(v), label: 'One uppercase letter' },
    { test: (v) => /[0-9]/.test(v), label: 'One number' },
];

const AdminAuth = () => {
    const navigate = useNavigate();
    const reduce = useReducedMotion();
    const { login } = useAuth();
    const { settings } = useSettings();

    const carrier = settings?.appName || 'App';
    const logoUrl = settings?.logoUrl || '';

    // 'login' | 'forgot-email' | 'forgot-otp' | 'forgot-reset'
    const [view, setView] = useState('login');
    const [isLoading, setIsLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [formData, setFormData] = useState({ email: '', password: '' });

    const password = formData.password || '';
    const emailReady = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(formData.email.trim());
    const passwordReady = password.length > 0;
    const ready = emailReady && passwordReady;

    // ── Forgot-password state ────────────────────────────────────────────
    const [resetEmail, setResetEmail] = useState('');
    const [resetCode, setResetCode] = useState('');
    const [resetCodeError, setResetCodeError] = useState('');
    const [resetToken, setResetToken] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showNewPassword, setShowNewPassword] = useState(false);
    const [resetTimer, setResetTimer] = useState(0);

    const resetEmailReady = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(resetEmail.trim());
    const unmetNewPasswordRules = PASSWORD_RULES.filter((rule) => !rule.test(newPassword));
    const newPasswordReady = unmetNewPasswordRules.length === 0;
    const confirmReady = confirmPassword.length > 0 && confirmPassword === newPassword;

    React.useEffect(() => {
        if (resetTimer <= 0) return undefined;
        const id = setInterval(() => setResetTimer((t) => Math.max(0, t - 1)), 1000);
        return () => clearInterval(id);
    }, [resetTimer]);

    const progress = (() => {
        if (view === 'login') return [emailReady, passwordReady].filter(Boolean).length / 2;
        if (view === 'forgot-email') return 0.15 + (resetEmailReady ? 0.1 : 0);
        if (view === 'forgot-otp') return 0.4 + 0.3 * (resetCode.length / CODE_LENGTH);
        return 0.7 + 0.3 * ([newPasswordReady, confirmReady].filter(Boolean).length / 2);
    })();

    const handleChange = (event) => {
        const { name, value } = event.target;
        setFormData((prev) => ({ ...prev, [name]: value }));
    };

    const handleSubmit = async (event) => {
        event.preventDefault();
        if (!ready) {
            if (!emailReady) toast.error('Enter the email on the admin account.');
            else toast.error('Enter the password.');
            return;
        }

        setIsLoading(true);
        try {
            const response = await adminApi.login({ email: formData.email.trim(), password });

            const { token, admin } = response.data.result;
            login({ ...admin, token, role: 'admin' });

            toast.success('Signed in');
            navigate('/admin');
        } catch (error) {
            toast.error(error.response?.data?.message || 'Authentication failed');
        } finally {
            setIsLoading(false);
        }
    };

    const goToForgotEmail = () => {
        setResetEmail(formData.email.trim());
        setResetCode('');
        setResetCodeError('');
        setResetToken('');
        setNewPassword('');
        setConfirmPassword('');
        setView('forgot-email');
    };

    const backToLogin = () => setView('login');

    const sendResetOtp = async (event) => {
        event?.preventDefault();
        if (!resetEmailReady) {
            toast.error('Enter the email on the admin account.');
            return;
        }

        setIsLoading(true);
        try {
            await adminApi.forgotPasswordSendOtp({ email: resetEmail.trim() });
            setResetCode('');
            setResetCodeError('');
            setView('forgot-otp');
            setResetTimer(RESEND_SECONDS);
            toast.success(`Reset code sent to ${resetEmail.trim()}`);
        } catch (error) {
            toast.error(
                error.response?.data?.message ||
                    "Couldn't send the reset code. Check the email and try again.",
            );
        } finally {
            setIsLoading(false);
        }
    };

    const verifyResetOtp = async (event) => {
        event?.preventDefault();
        if (resetCode.length !== CODE_LENGTH) {
            setResetCodeError(`Enter all ${CODE_LENGTH} digits.`);
            return;
        }

        setIsLoading(true);
        setResetCodeError('');
        try {
            const response = await adminApi.forgotPasswordVerifyOtp({
                email: resetEmail.trim(),
                otp: resetCode,
            });
            setResetToken(response.data.result.resetToken);
            setView('forgot-reset');
        } catch (error) {
            setResetCode('');
            setResetCodeError(
                error.response?.data?.message || "That code didn't match. Try again.",
            );
        } finally {
            setIsLoading(false);
        }
    };

    const submitNewPassword = async (event) => {
        event.preventDefault();
        if (!newPasswordReady) {
            toast.error(unmetNewPasswordRules[0]?.label || 'Check the password.');
            return;
        }
        if (!confirmReady) {
            toast.error('Passwords do not match.');
            return;
        }

        setIsLoading(true);
        try {
            await adminApi.resetPassword({
                email: resetEmail.trim(),
                resetToken,
                newPassword,
                confirmPassword,
            });
            toast.success('Password changed. Sign in with your new password.');
            setFormData({ email: resetEmail.trim(), password: '' });
            setResetToken('');
            setNewPassword('');
            setConfirmPassword('');
            setView('login');
        } catch (error) {
            toast.error(error.response?.data?.message || "Couldn't change the password. Try again.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div style={ADMIN_THEME_VARS}>
        <DepotGround>
            <ConsignmentNote>
                <NoteStub carrier={carrier} logoUrl={logoUrl}>
                    <div className="mt-5">
                        <Caption tone="paper">Operations desk</Caption>
                    </div>
                    <RouteLeader progress={progress} from="Credentials" to="Admitted" />
                </NoteStub>

                <TearEdge />

                <div className="relative px-6 pb-7 pt-5">
                    <AnimatePresence mode="wait" initial={false}>
                        {view === 'login' && (
                            <NotePane key="login" paneKey="login" direction={1}>
                                <motion.div
                                    variants={reduce ? undefined : stackIn}
                                    initial="hidden"
                                    animate="show"
                                    className="space-y-5"
                                >
                                    <motion.div variants={reduce ? undefined : stackItem}>
                                        <h1 className="text-[22px] font-extrabold leading-tight tracking-tight text-slate-900">
                                            Sign in
                                        </h1>
                                        <p className="mt-1 text-[13px] leading-snug text-slate-500">
                                            This desk manages couriers, partners and payouts.
                                        </p>
                                    </motion.div>

                                    <form onSubmit={handleSubmit} noValidate className="space-y-4">
                                        <motion.div variants={reduce ? undefined : stackItem}>
                                            <NoteField label="Email" filled={emailReady}>
                                                <input
                                                    type="email"
                                                    name="email"
                                                    autoComplete="username"
                                                    inputMode="email"
                                                    placeholder="you@company.com"
                                                    value={formData.email}
                                                    onChange={handleChange}
                                                    className={noteInput(emailReady)}
                                                />
                                            </NoteField>
                                        </motion.div>

                                        <motion.div variants={reduce ? undefined : stackItem}>
                                            <NoteField label="Password" filled={passwordReady}>
                                                <div className="relative">
                                                    <input
                                                        type={showPassword ? 'text' : 'password'}
                                                        name="password"
                                                        autoComplete="current-password"
                                                        placeholder="••••••••••"
                                                        value={password}
                                                        onChange={handleChange}
                                                        className={`${noteInput(passwordReady)} pr-12`}
                                                        style={{ fontFamily: MONO }}
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowPassword((v) => !v)}
                                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 outline-none transition-colors hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
                                                    >
                                                        {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                                                    </button>
                                                </div>
                                            </NoteField>
                                            <div className="mt-2 flex justify-end">
                                                <button
                                                    type="button"
                                                    onClick={goToForgotEmail}
                                                    className="rounded text-[11px] font-semibold text-slate-500 outline-none underline underline-offset-4 decoration-slate-200 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
                                                >
                                                    Forgot password?
                                                </button>
                                            </div>
                                        </motion.div>

                                        <motion.div variants={reduce ? undefined : stackItem} className="pt-1">
                                            <NoteAction type="submit" busy={isLoading} disabled={!ready}>
                                                <span className="inline-flex items-center gap-2.5">
                                                    Sign in
                                                    <ArrowRight size={15} strokeWidth={2.6} />
                                                </span>
                                            </NoteAction>
                                        </motion.div>
                                    </form>
                                </motion.div>
                            </NotePane>
                        )}

                        {view === 'forgot-email' && (
                            <NotePane key="forgot-email" paneKey="forgot-email" direction={1}>
                                <div className="space-y-5">
                                    <BackHeader
                                        onBack={backToLogin}
                                        title="Reset your password"
                                        caption="We'll email a code to the address on this admin account."
                                    />

                                    <form onSubmit={sendResetOtp} className="space-y-4">
                                        <NoteField label="Email" filled={resetEmailReady}>
                                            <input
                                                type="email"
                                                name="resetEmail"
                                                autoComplete="username"
                                                inputMode="email"
                                                placeholder="you@company.com"
                                                value={resetEmail}
                                                onChange={(event) => setResetEmail(event.target.value)}
                                                className={noteInput(resetEmailReady)}
                                            />
                                        </NoteField>

                                        <div className="pt-1">
                                            <NoteAction type="submit" busy={isLoading} disabled={!resetEmailReady}>
                                                <span className="inline-flex items-center gap-2.5">
                                                    Send code
                                                    <ArrowRight size={15} strokeWidth={2.6} />
                                                </span>
                                            </NoteAction>
                                        </div>
                                    </form>
                                </div>
                            </NotePane>
                        )}

                        {view === 'forgot-otp' && (
                            <NotePane key="forgot-otp" paneKey="forgot-otp" direction={1}>
                                <div className="space-y-5">
                                    <BackHeader
                                        onBack={() => setView('forgot-email')}
                                        title="Enter the code"
                                        caption={`Code sent to ${resetEmail.trim()}`}
                                    />

                                    <form onSubmit={verifyResetOtp} className="space-y-5">
                                        <NoteField error={resetCodeError}>
                                            <DeliveryCode
                                                value={resetCode}
                                                onChange={(next) => {
                                                    setResetCode(next);
                                                    if (resetCodeError) setResetCodeError('');
                                                }}
                                                length={CODE_LENGTH}
                                                error={Boolean(resetCodeError)}
                                                disabled={isLoading}
                                            />
                                        </NoteField>

                                        <NoteAction
                                            type="submit"
                                            busy={isLoading}
                                            disabled={resetCode.length !== CODE_LENGTH}
                                        >
                                            <span className="inline-flex items-center gap-2.5">
                                                Verify code
                                                <ArrowRight size={15} strokeWidth={2.6} />
                                            </span>
                                        </NoteAction>

                                        <div className="flex justify-center">
                                            <button
                                                type="button"
                                                onClick={sendResetOtp}
                                                disabled={resetTimer > 0 || isLoading}
                                                className="rounded text-[10px] uppercase tracking-[0.16em] font-bold text-[color:var(--primary)] outline-none underline underline-offset-4 decoration-slate-200 disabled:text-slate-300 disabled:no-underline focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
                                                style={{ fontFamily: MONO }}
                                            >
                                                {resetTimer > 0 ? `Resend in ${resetTimer}s` : 'Resend code'}
                                            </button>
                                        </div>
                                    </form>
                                </div>
                            </NotePane>
                        )}

                        {view === 'forgot-reset' && (
                            <NotePane key="forgot-reset" paneKey="forgot-reset" direction={1}>
                                <div className="space-y-5">
                                    <BackHeader
                                        onBack={() => setView('forgot-otp')}
                                        title="Set a new password"
                                        caption="This replaces the current password immediately."
                                    />

                                    <form onSubmit={submitNewPassword} className="space-y-4">
                                        <motion.div>
                                            <NoteField label="New password" filled={newPasswordReady}>
                                                <div className="relative">
                                                    <input
                                                        type={showNewPassword ? 'text' : 'password'}
                                                        name="newPassword"
                                                        autoComplete="new-password"
                                                        placeholder="••••••••••"
                                                        value={newPassword}
                                                        onChange={(event) => setNewPassword(event.target.value)}
                                                        className={`${noteInput(newPasswordReady)} pr-12`}
                                                        style={{ fontFamily: MONO }}
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowNewPassword((v) => !v)}
                                                        aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                                                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 outline-none transition-colors hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
                                                    >
                                                        {showNewPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                                                    </button>
                                                </div>
                                            </NoteField>

                                            {newPassword.length > 0 && unmetNewPasswordRules.length > 0 && (
                                                <ul className="mt-2 space-y-1">
                                                    {unmetNewPasswordRules.map((rule) => (
                                                        <li
                                                            key={rule.label}
                                                            className="flex items-center gap-2 text-[11px] font-medium text-slate-400"
                                                        >
                                                            <span
                                                                aria-hidden
                                                                className="h-1 w-1 rounded-full bg-slate-300"
                                                            />
                                                            {rule.label}
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </motion.div>

                                        <NoteField
                                            label="Confirm password"
                                            filled={confirmReady}
                                            error={
                                                confirmPassword.length > 0 && !confirmReady
                                                    ? 'Passwords do not match'
                                                    : ''
                                            }
                                        >
                                            <input
                                                type={showNewPassword ? 'text' : 'password'}
                                                name="confirmPassword"
                                                autoComplete="new-password"
                                                placeholder="••••••••••"
                                                value={confirmPassword}
                                                onChange={(event) => setConfirmPassword(event.target.value)}
                                                className={noteInput(confirmReady, confirmPassword.length > 0 && !confirmReady)}
                                                style={{ fontFamily: MONO }}
                                            />
                                        </NoteField>

                                        <div className="pt-1">
                                            <NoteAction
                                                type="submit"
                                                busy={isLoading}
                                                disabled={!newPasswordReady || !confirmReady}
                                            >
                                                <span className="inline-flex items-center gap-2.5">
                                                    Change password
                                                    <ArrowRight size={15} strokeWidth={2.6} />
                                                </span>
                                            </NoteAction>
                                        </div>
                                    </form>
                                </div>
                            </NotePane>
                        )}
                    </AnimatePresence>
                </div>
            </ConsignmentNote>
        </DepotGround>
        </div>
    );
};

/** Back-button + title, repeated across every forgot-password step. */
const BackHeader = ({ onBack, title, caption }) => (
    <div className="flex items-start gap-3">
        <button
            type="button"
            onClick={onBack}
            aria-label="Go back"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 outline-none transition-colors hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
        >
            <ArrowLeft size={17} />
        </button>
        <div className="min-w-0">
            <h1 className="text-[22px] font-extrabold tracking-tight text-slate-900 leading-tight">
                {title}
            </h1>
            <Caption className="mt-1.5">{caption}</Caption>
        </div>
    </div>
);

export default AdminAuth;
