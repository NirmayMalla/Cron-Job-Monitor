'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';

import { Trash2 } from 'lucide-react'; 

import MonitorCharts from './monitor-chart';

const EVENT_LABELS = { run: 'Run', complete: 'Complete', fail: 'Fail' };

const STATUS_BADGE = {
	ok: { label: 'OK', cls: 'bg-emerald-500/20 text-emerald-400' },
	late: { label: 'LATE', cls: 'bg-amber-500/20 text-amber-400' },
	failed: { label: 'FAILED', cls: 'bg-red-500/20 text-red-400' },
};

function statusColor(status) {
	if (status === 'ok') return 'bg-emerald-500';
	if (status === 'late') return 'bg-amber-500';
	if (status === 'failed') return 'bg-red-500';
	if (status === 'pending') return 'bg-sky-500';
	return 'bg-neutral-500';
}

function formatDuration(s) {
	if (s == null) return '—';
	if (s < 60) return `${Number(s.toFixed(3))}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function formatInterval(total) {
	if (!total) return 'no schedule';
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return (
		'every ' +
		[h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ')
	);
}

export default function Home() {
	const router = useRouter();
	const [user, setUser] = useState(null); // null until we know who is logged in
	const [monitors, setMonitors] = useState([]);
	const [selectedId, setSelectedId] = useState(null);
	const [events, setEvents] = useState(null); // null = still loading
	const [baseUrl, setBaseUrl] = useState('');
	const [telemetryKey, setTelemetryKey] = useState('');
	const [copied, setCopied] = useState(false);

	const [showForm, setShowForm] = useState(false);
	const [monitorName, setMonitorName] = useState('');
	const [hours, setHours] = useState('');
	const [minutes, setMinutes] = useState('');
	const [seconds, setSeconds] = useState('');
	const [grace, setGrace] = useState('');
	const [formError, setFormError] = useState('');

	// Returns true (and redirects) if the session is gone
	function handleUnauthorized(res) {
		if (res.status === 401) {
			router.replace('/login');
			return true;
		}
		return false;
	}

	async function fetchMonitors() {
		try {
			const response = await api('/monitors');
			if (handleUnauthorized(response)) return;
			if (!response.ok) throw new Error('Failed to fetch monitors');
			setMonitors(await response.json());
		} catch (err) {
			console.log(err);
		}
	}

	async function fetchEvents(id) {
		try {
			const response = await api(`/monitors/${id}/pings`);
			if (handleUnauthorized(response)) return;
			if (!response.ok) throw new Error('Failed to fetch events');
			setEvents(await response.json());
		} catch (err) {
			console.log(err);
		}
	}

	// 1. Who is logged in? No session means go to the login page.
	useEffect(() => {
		api('/auth/me')
			.then((res) => {
				if (res.ok) return res.json();
				router.replace('/login');
				return null;
			})
			.then((u) => {
				if (u) setUser(u);
			})
			.catch((err) => console.log(err));
	}, [router]);

	// 2. Load this user's telemetry key
	useEffect(() => {
		if (!user) return;
		api('/config')
			.then((r) => r.json())
			.then((c) => {
				setBaseUrl(c.telemetry_base_url);
				setTelemetryKey(c.telemetry_key);
			})
			.catch((err) => console.log(err));
	}, [user]);

	// 3. Poll monitors, and the selected monitor's events
	useEffect(() => {
		if (!user) return;
		fetchMonitors();
		if (selectedId) fetchEvents(selectedId);

		const timer = setInterval(() => {
			fetchMonitors();
			if (selectedId) fetchEvents(selectedId);
		}, 3000);

		return () => clearInterval(timer);
	}, [user, selectedId]);

	function selectMonitor(id) {
		if (id === selectedId) return;
		setEvents(null);
		setSelectedId(id);
	}


	async function logout() {
		try {
			await api('/auth/logout', { method: 'POST' });
		} catch (err) {
			console.log(err);
		}
		router.replace('/login');
	}


	async function copyKey() {
		try {
			await navigator.clipboard.writeText(telemetryKey);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch (err) {
			console.log(err);
		}
	}


	async function regenerateKey() {
		if (
			!window.confirm(
				'Generate a new key? Every script using the old key will stop working until you update its URL.',
			)
		)
			return;
		try {
			const response = await api('/config/regenerate-key', {
				method: 'POST',
			});
			if (handleUnauthorized(response)) return;
			if (!response.ok) throw new Error('Failed to regenerate key');
			const c = await response.json();
			setTelemetryKey(c.telemetry_key);
			setBaseUrl(c.telemetry_base_url);
		} catch (err) {
			console.log(err);
		}
	}


	async function handleCreate(e) {
		e.preventDefault();
		setFormError('');

		const total =
			(parseInt(hours) || 0) * 3600 +
			(parseInt(minutes) || 0) * 60 +
			(parseInt(seconds) || 0);

		try {
			const response = await api('/monitors', {
				method: 'POST',
				body: JSON.stringify({
					monitor_name: monitorName,
					expected_interval: total > 0 ? total : undefined,
					grace_period: parseInt(grace) || 0,
				}),
			});
			if (handleUnauthorized(response)) return;
			if (!response.ok) {
				setFormError(
					'Name can only contain letters, numbers, - and _ (max 64 characters).',
				);
				return;
			}
			const created = await response.json();
			setMonitorName('');
			setHours('');
			setMinutes('');
			setSeconds('');
			setGrace('');
			setShowForm(false);
			await fetchMonitors();
			selectMonitor(created.id);
		} catch (err) {
			console.log(err);
		}
	}
	
	async function deleteMonitor(id, name) {
		if (
			!window.confirm(
				`Delete "${name}" and all of its history? This can't be undone.`,
			)
		)
			return;
		try {
			const response = await api(`/monitors/${id}`, { method: 'DELETE' });
			if (handleUnauthorized(response)) return;
			if (!response.ok) throw new Error('Failed to delete monitor');
			if (id === selectedId) {
				setSelectedId(null);
				setEvents(null);
				setRenaming(false);
			}
			await fetchMonitors();
		} catch (err) {
			console.log(err);
		}
	}

	if (!user) return null; // still checking the session (or redirecting to /login)

	const selected = monitors.find((m) => m.id === selectedId);
	// const pingUrl =
	// 	selected && baseUrl ? `${baseUrl}/${selected.monitor_key}` : '';

	const inputClass =
		'rounded-md bg-transparent border border-neutral-500 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none';

	return (
		<main className='min-h-screen bg-neutral-800 text-white'>
			<div className='mx-auto max-w-6xl px-6 py-12'>
				<div className='flex items-center justify-between mb-8'>
					<h1 className='text-2xl font-semibold'>Cron Job Monitor</h1>
					<div className='flex items-center gap-3'>
						<span className='text-xs text-neutral-400'>
							{user.email}
						</span>
						<button
							onClick={() => setShowForm(!showForm)}
							className='border border-neutral-500 rounded-md px-4 py-2 text-sm text-neutral-300 hover:border-neutral-300 transition-colors cursor-pointer'
						>
							{showForm ? 'Cancel' : 'Add monitor'}
						</button>
						<button
							onClick={logout}
							className='border border-neutral-700 rounded-md px-4 py-2 text-sm text-neutral-400 hover:border-neutral-400 transition-colors cursor-pointer'
						>
							Log out
						</button>
					</div>
				</div>

				<div className='mb-8 rounded-lg bg-neutral-900 p-4 flex flex-wrap items-center gap-3'>
					<span className='text-xs text-neutral-400'>
						Your telemetry key
					</span>
					<code className='text-xs text-neutral-200 break-all'>
						{telemetryKey || 'loading...'}
					</code>
					<button
						onClick={copyKey}
						className='border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-300 hover:border-neutral-300 transition-colors cursor-pointer'
					>
						{copied ? 'Copied' : 'Copy'}
					</button>
					<button
						onClick={regenerateKey}
						className='border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-300 hover:border-red-400 hover:text-red-400 transition-colors cursor-pointer'
					>
						Regenerate
					</button>
				</div>

				{showForm && (
					<form onSubmit={handleCreate} className='mb-8'>
						<div className='flex flex-wrap items-end gap-4'>
							<input
								placeholder='monitor-name'
								value={monitorName}
								onChange={(e) => setMonitorName(e.target.value)}
								maxLength={64}
								required
								className={`${inputClass} w-64`}
							/>
							<div>
								<label className='block text-xs text-neutral-400 mb-1.5'>
									Expected interval (optional)
								</label>
								<div className='flex items-center gap-2'>
									<input
										type='number'
										min='0'
										placeholder='0'
										value={hours}
										onChange={(e) =>
											setHours(e.target.value)
										}
										className={`${inputClass} w-16 text-center`}
									/>
									<span className='text-xs text-neutral-500'>
										hr
									</span>
									<input
										type='number'
										min='0'
										max='59'
										placeholder='0'
										value={minutes}
										onChange={(e) =>
											setMinutes(e.target.value)
										}
										className={`${inputClass} w-16 text-center`}
									/>
									<span className='text-xs text-neutral-500'>
										min
									</span>
									<input
										type='number'
										min='0'
										max='59'
										placeholder='0'
										value={seconds}
										onChange={(e) =>
											setSeconds(e.target.value)
										}
										className={`${inputClass} w-16 text-center`}
									/>
									<span className='text-xs text-neutral-500'>
										sec
									</span>
								</div>
							</div>
							<input
								type='number'
								min='0'
								placeholder='Grace period (sec)'
								value={grace}
								onChange={(e) => setGrace(e.target.value)}
								className={`${inputClass} w-48`}
							/>
							<button
								type='submit'
								className='border border-neutral-500 rounded-md px-4 py-2 text-sm text-neutral-300 hover:border-emerald-400 hover:text-emerald-400 transition-colors cursor-pointer'
							>
								Create
							</button>
						</div>
						{formError && (
							<p className='mt-3 text-xs text-red-400'>
								{formError}
							</p>
						)}
					</form>
				)}

				{monitors.length === 0 ? (
					<div className='mt-10 rounded-lg border border-dashed border-neutral-500 py-16 text-center'>
						<p className='text-sm'>No monitors yet.</p>
						<p className='text-xs text-neutral-400 mt-1'>
							Add one here, or just curl a new name and it will
							appear.
						</p>
					</div>
				) : (
					<div className='grid grid-cols-1 md:grid-cols-[260px_1fr] gap-6'>
						<div className='rounded-lg overflow-hidden divide-y divide-neutral-800 self-start'>
							{monitors.map((m) => (
								<div
									key={m.id}
									onClick={() => selectMonitor(m.id)}
									className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
										m.id === selectedId
											? 'bg-neutral-700'
											: 'bg-neutral-900 hover:bg-neutral-800'
									}`}
								>
									<span
										className={`h-2.5 w-2.5 rounded-full shrink-0 ${statusColor(m.status)}`}
									/>
									<span className='text-sm truncate'>
										{m.name}
									</span>
									<span className='ml-auto text-xs text-neutral-400'>
										{m.status}
									</span>
									<button
										onClick={(e) => {
											e.stopPropagation();
											deleteMonitor(m.id, m.name);
										}}
										title='Delete monitor'
										aria-label={`Delete ${m.name}`}
										className='shrink-0 text-neutral-500 hover:text-red-400 transition-colors cursor-pointer'
									>
										<Trash2 size={16} />
									</button>
								</div>
							))}
						</div>

						<div className='rounded-lg bg-neutral-900 p-6'>
							{!selected ? (
								<p className='text-sm text-neutral-400'>
									Select a monitor to see its events.
								</p>
							) : (
								<>
									<div className='flex items-center gap-3'>
										<span
											className={`h-3 w-3 rounded-full ${statusColor(selected.status)}`}
										/>
										<h2 className='text-lg font-semibold'>
											{selected.name}
										</h2>
										<span className='text-xs text-neutral-400 uppercase'>
											{selected.status}
										</span>
									</div>
									<p className='text-xs text-neutral-400 mt-2'>
										{formatInterval(
											selected.expected_interval,
										)}
										{selected.expected_interval
											? `, grace ${selected.grace_period}s`
											: ''}
										{' · last ping '}
										{selected.last_ping_at
											? new Date(
													selected.last_ping_at,
												).toLocaleString()
											: 'never'}
									</p>
									<MonitorCharts
										key={selected.id}
										monitorId={selected.id}
									/>
									<table className='w-full mt-6 text-sm text-left'>
										<thead>
											<tr className='text-xs text-neutral-500'>
												<th className='py-2 font-normal'>
													Time
												</th>
												<th className='py-2 font-normal'>
													Event
												</th>
												<th className='py-2 font-normal'>
													Status
												</th>
												<th className='py-2 font-normal'>
													Duration
												</th>
											</tr>
										</thead>
										<tbody>
											{events === null ? (
												<tr>
													<td
														colSpan={4}
														className='py-3 text-xs text-neutral-500'
													>
														Loading...
													</td>
												</tr>
											) : events.length === 0 ? (
												<tr>
													<td
														colSpan={4}
														className='py-3 text-xs text-neutral-500'
													>
														No events yet. Run one
														of the curl commands
														above.
													</td>
												</tr>
											) : (
												events.map((ev) => {
													const badge =
														STATUS_BADGE[
															ev.status
														] || STATUS_BADGE.ok;
													return (
														<tr
															key={ev.id}
															className='border-t border-neutral-800 text-neutral-300'
														>
															<td className='py-2'>
																{new Date(
																	ev.timestamp,
																).toLocaleString()}
															</td>
															<td className='py-2'>
																{EVENT_LABELS[
																	ev.state
																] || ev.state}
															</td>
															<td className='py-2'>
																<span
																	className={`rounded px-2 py-0.5 text-xs font-medium ${badge.cls}`}
																>
																	{
																		badge.label
																	}
																</span>
															</td>
															<td className='py-2'>
																{formatDuration(
																	ev.duration,
																)}
															</td>
														</tr>
													);
												})
											)}
										</tbody>
									</table>
								</>
							)}
						</div>
					</div>
				)}
			</div>
		</main>
	);
}
