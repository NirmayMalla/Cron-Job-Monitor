'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../api';

export default function LoginPage() {
	const router = useRouter();
	const [mode, setMode] = useState('login'); // "login" or "signup"
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	async function handleSubmit(e) {
		e.preventDefault();
		setError('');
		setBusy(true);
		try {
			const res = await api(`/auth/${mode}`, {
				method: 'POST',
				body: JSON.stringify({ email, password }),
			});
			if (res.ok) {
				router.replace('/');
				return;
			}
			if (res.status === 429)
				setError('Too many attempts. Wait a minute and try again.');
			else if (res.status === 409)
				setError('An account with that email already exists.');
			else if (res.status === 401) setError('Invalid email or password.');
			else if (res.status === 400)
				setError(
					mode === 'signup'
						? 'Enter a valid email and a password of at least 10 characters.'
						: 'Enter your email and password.',
				);
			else setError('Something went wrong. Try again.');
		} catch (err) {
			setError("Can't reach the server.");
		} finally {
			setBusy(false);
		}
	}

	const inputClass =
		'w-full rounded-md bg-transparent border border-neutral-500 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-300';

	return (
		<main className='min-h-screen bg-neutral-800 flex items-center justify-center px-6'>
			<form
				onSubmit={handleSubmit}
				className='w-full max-w-sm rounded-lg bg-neutral-900 p-8'
			>
				<h1 className='text-xl font-semibold text-white mb-1'>
					{mode === 'login' ? 'Log in' : 'Create account'}
				</h1>
				<p className='text-xs text-neutral-400 mb-6'>
					Cron Job Monitor
				</p>

				<label className='block text-xs text-neutral-400 mb-1.5'>
					Email
				</label>
				<input
					type='email'
					autoComplete='email'
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
					className={`${inputClass} mb-4`}
				/>

				<label className='block text-xs text-neutral-400 mb-1.5'>
					Password
				</label>
				<input
					type='password'
					autoComplete={
						mode === 'login' ? 'current-password' : 'new-password'
					}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					minLength={mode === 'signup' ? 10 : undefined}
					maxLength={128}
					required
					className={inputClass}
				/>
				{mode === 'signup' && (
					<p className='text-xs text-neutral-500 mt-1.5'>
						At least 10 characters.
					</p>
				)}

				{error && <p className='text-xs text-red-400 mt-4'>{error}</p>}

				<button
					type='submit'
					disabled={busy}
					className='mt-6 w-full border border-neutral-500 rounded-md px-4 py-2 text-sm text-neutral-200 hover:border-emerald-400 hover:text-emerald-400 transition-colors cursor-pointer disabled:opacity-50'
				>
					{busy ? '...' : mode === 'login' ? 'Log in' : 'Sign up'}
				</button>

				<button
					type='button'
					onClick={() => {
						setMode(mode === 'login' ? 'signup' : 'login');
						setError('');
					}}
					className='mt-4 w-full text-xs text-neutral-400 hover:text-neutral-200 cursor-pointer'
				>
					{mode === 'login'
						? 'No account? Sign up'
						: 'Have an account? Log in'}
				</button>
			</form>
		</main>
	);
}
