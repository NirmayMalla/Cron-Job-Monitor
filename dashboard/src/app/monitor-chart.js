'use client';

import { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { api } from './api';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const RANGES = [
	{ hours: 1, label: '1h', bucketMs: 2 * MIN, bucketLabel: '2 minutes' },
	{ hours: 6, label: '6h', bucketMs: 10 * MIN, bucketLabel: '10 minutes' },
	{ hours: 24, label: '24h', bucketMs: 30 * MIN, bucketLabel: '30 minutes' },
	{ hours: 168, label: '7d', bucketMs: 4 * HOUR, bucketLabel: '4 hours' },
];

const COLORS = {
	ok: '#10b981',
	late: '#f59e0b',
	failed: '#ef4444',
	avg: '#38bdf8',
	max: '#a78bfa',
};
const AXIS = { stroke: '#525252', tick: { fill: '#a3a3a3', fontSize: 11 } };

function formatDuration(s) {
	if (s == null) return '-';
	if (s < 60) return `${Number(s.toFixed(3))}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function formatAxisDuration(v) {
	const t = Math.round(v);
	if (t < 60) return `${t}s`;
	return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

const shortDate = (ms) =>
	new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

// Group raw pings into evenly spaced time buckets, so dots can never overlap
function buildBuckets(points, from, to, bucketMs) {
	const n = Math.round((to - from) / bucketMs);
	const buckets = Array.from({ length: n }, (_, i) => ({
		start: from + i * bucketMs,
		end: from + (i + 1) * bucketMs,
		ok: 0,
		late: 0,
		failed: 0,
		durations: [],
	}));

	for (const p of points) {
		const i = Math.min(n - 1, Math.floor((p.t - from) / bucketMs));
		if (i < 0) continue;
		const key =
			p.status === 'late' || p.status === 'failed' ? p.status : 'ok';
		buckets[i][key] += 1;
		if (p.duration != null) buckets[i].durations.push(p.duration);
	}

	return buckets.map((b) => ({
		start: b.start,
		end: b.end,
		ok: b.ok,
		late: b.late,
		failed: b.failed,
		runs: b.durations.length,
		avg: b.durations.length
			? b.durations.reduce((a, c) => a + c, 0) / b.durations.length
			: null,
		max: b.durations.length ? Math.max(...b.durations) : null,
	}));
}

function BucketTooltip({ active, payload, view }) {
	if (!active || !payload || payload.length === 0) return null;
	const b = payload[0].payload;
	return (
		<div className='rounded-md border border-neutral-700 bg-black px-3 py-2 text-xs text-neutral-200'>
			<div className='mb-1 text-neutral-400'>
				{shortDate(b.start)} to {shortDate(b.end)}
			</div>
			{view === 'pings' ? (
				<>
					<div>OK: {b.ok}</div>
					{b.late > 0 && <div>Late: {b.late}</div>}
					{b.failed > 0 && <div>Failed: {b.failed}</div>}
				</>
			) : b.runs === 0 ? (
				<div>No finished runs</div>
			) : (
				<>
					<div>Finished runs: {b.runs}</div>
					<div>Average: {formatDuration(b.avg)}</div>
					<div>Slowest: {formatDuration(b.max)}</div>
				</>
			)}
		</div>
	);
}

function RunTooltip({ active, payload }) {
	if (!active || !payload || payload.length === 0) return null;
	const r = payload[0].payload;
	return (
		<div className='rounded-md border border-neutral-700 bg-black px-3 py-2 text-xs text-neutral-200'>
			<div className='text-neutral-400'>{shortDate(r.t)}</div>
			<div>{r.status.toUpperCase()}</div>
			<div>Took {formatDuration(r.duration)}</div>
		</div>
	);
}

export default function MonitorCharts({ monitorId }) {
	const [hours, setHours] = useState(24);
	const [view, setView] = useState('pings'); // "pings" | "duration"
	const [data, setData] = useState(null); // null = loading

	useEffect(() => {
		let cancelled = false;
		setData(null);
		const bucketMs = RANGES.find((r) => r.hours === hours).bucketMs;

		async function load() {
			try {
				const res = await api(
					`/monitors/${monitorId}/chart?hours=${hours}`,
				);
				if (!res.ok) throw new Error('Failed to load chart data');
				const rows = await res.json();
				if (cancelled) return;

				const to = Date.now();
				const from = to - hours * HOUR;
				const points = rows.map((r) => ({
					...r,
					t: new Date(r.timestamp).getTime(),
				}));
				setData({
					points,
					buckets: buildBuckets(points, from, to, bucketMs),
				});
			} catch (err) {
				console.log(err);
			}
		}

		load();
		const timer = setInterval(load, 5000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [monitorId, hours]);

	if (!data) {
		return (
			<p className='mt-6 text-xs text-neutral-500'>Loading charts...</p>
		);
	}

	const { points, buckets } = data;
	const range = RANGES.find((r) => r.hours === hours);

	const finished = points.filter(
		(p) => p.state === 'complete' || p.state === 'fail',
	);
	const sorted = finished.filter((p) => p.duration != null).map((p) => p.duration).sort((a, b) => a - b);
	const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;

	const runs = finished.filter((p) => p.duration != null).slice(-60); // most recent 60 runs

	const stats = [
		['Finished runs', finished.length],
		['Avg', formatDuration(avg)],
		//['p95', formatDuration(percentile(sorted, 0.95))],
		['Max', formatDuration(sorted[sorted.length - 1])],
		['Failed', points.filter((p) => p.status === 'failed').length],
		['Late', points.filter((p) => p.status === 'late').length],
	];

	// const hasLate = buckets.some((b) => b.late > 0);
	// const hasFailed = buckets.some((b) => b.failed > 0);

	const formatTime = (v) => {
		const d = new Date(v);
		return hours > 24
			? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
			: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	};

	const xAxis = (
		<XAxis
			dataKey='start'
			tickFormatter={formatTime}
			minTickGap={40}
			{...AXIS}
		/>
	);
	const grid = <CartesianGrid stroke='#262626' vertical={false} />;
	//const cursor = { stroke: '#525252', strokeDasharray: '3 3' };
	const margin = { top: 8, right: 16, bottom: 0, left: 0 };

    const legend = [
        ['ok', 'OK'],
        ['late', 'Late'],
        ['failed', 'Failed'],
    ];

	return (
		<div className='mt-6'>
			<div className='flex items-center justify-between mb-4'>
				<div className='flex gap-1 rounded-md bg-neutral-800 p-1'>
					{[
						['pings', 'Pings'],
						['duration', 'Duration'],
					].map(([key, label]) => (
						<button
							key={key}
							onClick={() => setView(key)}
							className={`rounded px-3 py-1 text-xs cursor-pointer transition-colors ${
								view === key
									? 'bg-neutral-600 text-white'
									: 'text-neutral-400 hover:text-neutral-200'
							}`}
						>
							{label}
						</button>
					))}
				</div>
				<div className='flex gap-1'>
					{RANGES.map((r) => (
						<button
							key={r.hours}
							onClick={() => setHours(r.hours)}
							className={`rounded px-2 py-1 text-xs cursor-pointer transition-colors ${
								hours === r.hours
									? 'bg-neutral-700 text-white'
									: 'text-neutral-400 hover:text-neutral-200'
							}`}
						>
							{r.label}
						</button>
					))}
				</div>
			</div>

			<div className='grid grid-cols-3 sm:grid-cols-6 gap-3 mb-5'>
				{stats.map(([label, value]) => (
					<div
						key={label}
						className='rounded-md bg-neutral-800 px-3 py-2'
					>
						<div className='text-xs text-neutral-500'>{label}</div>
						<div className='text-sm text-neutral-200'>{value}</div>
					</div>
				))}
			</div>

			<div className='flex gap-4 text-xs text-neutral-400 mb-2'>
				{legend.map(([key, label]) => (
					<span
						key={key}
						className='inline-flex items-center gap-1.5'
					>
						<span
							className='h-2 w-2 rounded-full'
							style={{ backgroundColor: COLORS[key] }}
						/>
						{label}
					</span>
				))}
			</div>

			{points.length === 0 ? (
				<p className='py-10 text-center text-xs text-neutral-500'>
					No pings in this period.
				</p>
			) : view === 'pings' ? (
				<div className='h-64'>
					<ResponsiveContainer width='100%' height='100%'>
						<BarChart
							data={buckets}
							margin={margin}
							barCategoryGap='15%'
						>
							{grid}
							{xAxis}
							<YAxis
								allowDecimals={false}
								domain={[0, (max) => Math.max(max, 1)]}
								width={40}
								{...AXIS}
							/>
							<Tooltip
								content={<BucketTooltip view='pings' />}
								cursor={{ fill: '#262626' }}
							/>
							<Bar
								dataKey='ok'
								stackId='pings'
								fill={COLORS.ok}
								isAnimationActive={false}
							/>
							<Bar
								dataKey='late'
								stackId='pings'
								fill={COLORS.late}
								isAnimationActive={false}
							/>
							<Bar
								dataKey='failed'
								stackId='pings'
								fill={COLORS.failed}
								isAnimationActive={false}
							/>
						</BarChart>
					</ResponsiveContainer>
				</div>
			) : sorted.length === 0 ? (
				<p className='py-10 text-center text-xs text-neutral-500'>
					No finished runs with a duration in this period.
				</p>
			) : (
				<div className='h-64'>
					<ResponsiveContainer width='100%' height='100%'>
						<BarChart data={runs} margin={margin}>
							{grid}
							<XAxis
								dataKey='t'
								tickFormatter={formatTime}
								minTickGap={40}
								{...AXIS}
							/>
							<YAxis
								domain={[0, 'auto']}
								tickFormatter={formatAxisDuration}
								width={50}
								{...AXIS}
							/>
							<Tooltip
								content={<RunTooltip />}
								cursor={{ fill: '#262626' }}
							/>
							{avg != null && (
								<ReferenceLine
									y={avg}
									stroke={COLORS.avg}
									strokeDasharray='4 3'
								/>
							)}
							<Bar
								dataKey='duration'
								maxBarSize={28}
								isAnimationActive={false}
							>
								{runs.map((r) => (
									<Cell
										key={r.id}
										fill={COLORS[r.status] || COLORS.ok}
									/>
								))}
							</Bar>
						</BarChart>
					</ResponsiveContainer>
				</div>
			)}

			<p className='mt-2 text-xs text-neutral-500'>
				{view === 'pings'
					? `Each bar groups ${range.bucketLabel} of activity.`
                    : 'Each bar is one finished run. The dashed line is the average.'
                }
			</p>
		</div>
	);
}
