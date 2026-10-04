"use client";

import { useState, useEffect } from "react";

export default function Home() {
  const [monitors, setMonitors] = useState([]);
  const [monitorName, setMonitorName] = useState("");
  const [expectedInterval, setExpectedInterval] = useState("");
  const [grace, setGrace] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  async function toggleHistory(monitorId) {
    if (expandedId === monitorId) {
      setExpandedId(null);
      return;
    }

    setExpandedId(monitorId);

    // To indicate loading wait
    setLoadingHistory(true);

    try {
      const response = await fetch(`http://localhost:5000/monitors/${monitorId}/pings`);

      if (!response.ok)
        throw new Error("Failed to fetch history");

      const data = await response.json();
      setHistory(data);
    }
    
    catch(err) {
      console.log(err);
    }
    
    finally {
      setLoadingHistory(false);
    }
  }

  async function fetchMonitors() {
    try {
      const response = await fetch("http://localhost:5000/monitors");
      
      if (!response.ok) 
        throw new Error("Failed to fetch monitors");
      
      const data = await response.json();
      setMonitors(data);
    }
    catch(err) {
      console.log(err);
    }
  }

  useEffect(() => {
    fetchMonitors();

    const interval = setInterval(fetchMonitors, 500);

    return () => clearInterval(interval);
  }, []);
  

  async function ping(monitor_key, state) {
    try {
      const response = await fetch(`http://localhost:5000/ping/${monitor_key}?state=${state}`);

      if (!response.ok)
        throw new Error("Something went wrong");

      fetchMonitors();
      console.log(`Ping ${state}`);
    }
    catch (err) {
      console.log(err);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    try {
      const response = await fetch("http://localhost:5000/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monitor_name: monitorName,
          expected_interval: parseInt(expectedInterval),
          grace_period: parseInt(grace) || 0,
        })
      });
      if (!response.ok) 
        throw new Error("Failed to create monitor");
      setMonitorName("");
      setExpectedInterval("");
      setGrace("");
      setShowForm(false);
      fetchMonitors();    // refresh list
    }
    catch(err) {
      console.log(err);
    }
  }

  function statusColor(status) {
    if (status === "ok") return "bg-emerald-500";
    if (status === "late") return "bg-amber-500";
    if (status === "failed") return "bg-red-500";
    return "bg-neutral-500";
  }

  return (
    <main className="min-h-screen bg-neutral-800">
      <div className="mx-auto max-w-4xl px-6 py-12">
        <div className="flex items-center justify-between mb-10">
          <h1 className="text-2xl font-semibold text-white">
            Cron Job Monitor
          </h1>
          <button 
            onClick={() => setShowForm(!showForm)} 
            className="border-1 border-neutral-500 rounded-md bg-transparent px-4 py-2 text-sm font-medium text-neutral-500 hover:border-neutral-300 hover:text-neutral-300 transition-colors cursor-pointer">
            {showForm ? "Cancel" : "Add monitor"} 
          </button>
        </div>
        {showForm && (
          <form 
            onSubmit={handleCreate}
            /* className="mb-rounded-lg border border-neutral-800 bg-gray-900" */
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <input
                  placeholder="Monitor name"
                  value={monitorName}
                  onChange={(e) => setMonitorName(e.target.value)}
                  required
                  className="w-full rounded-md bg-transparent border border-neutral-500 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none"
                />
              </div>
              <div>
                <input
                  placeholder="Expected interval (seconds)"
                  type="number"
                  value={expectedInterval}
                  onChange={(e) => setExpectedInterval(e.target.value)}
                  required
                  className="w-full rounded-md bg-transparent border border-neutral-500 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none"
                />
              </div>
              <div>
                <input
                  placeholder="Grace period (seconds)"
                  type="number"
                  value={grace}
                  onChange={(e) => setGrace(e.target.value)}
                  required
                  className="w-full rounded-md bg-transparent border border-neutral-500 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none"
                />
              </div>
            </div>
            <button 
              type="submit"
              className="border-1 border-solid border-neutral-500 mt-4 rounded-md bg-transparent px-4 py-2 text-sm text-neutral-500 hover:border-emerald-400 hover:text-emerald-400 transition-colors cursor-pointer"
            >
              Create
            </button>
          </form>
        )}
        <div>
          {monitors.length == 0 ? (
            <div className="mt-10 rounded-lg border border-dashed border-white py-16 text-center">
              <p className="text-white text-sm">No monitors created yet</p>
            </div>
          ) : ( 
            <div className="divide-y divide-slate-800 overflow-hidden">
              {monitors.map((monitor) => (
                <div key={monitor.id} className="flex flex-col gap-2">
                  <div
                    className="flex items-center justify-between px-5 py-4 bg-neutral-900 transition-colors rounded-lg"
                    onClick={() => toggleHistory(monitor.id)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${statusColor(monitor.status)}`}
                      />
                      <h3 className="text-sm font-medium text-white">
                        {monitor.name}
                      </h3>
                      <p className="text-xs text-neutral-400">
                        {monitor.status}
                      </p>
                    </div>
                    <button 
                      onClick={() => ping(monitor.monitor_key, 'completed')}
                      className="rounded border border-transparent px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600 transition-colors cursor-pointer"
                      >
                        Complete
                    </button>
                    <button 
                      onClick={() => ping(monitor.monitor_key, 'failed')}
                      className="rounded border border-transparent px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600 transition-colors cursor-pointer"
                      >
                        Fail
                    </button>
                  </div>
                  
                  {expandedId === monitor.id && (
                    <div className="px-5 pb-5 bg-neutral-900 rounded-lg">
                      {loadingHistory ? (
                        <p className="text-xs text-neutral-500 pt-3">
                          Loading...
                        </p>
                      ) : history.length === 0 ? (
                        <p className="text-xs text-neutral-500 pt-3">No pings recorded yet</p>
                      ) : (
                        <table className="w-full mt-3 text-xs text-left">
                          <thead>
                            <tr className="text-neutral-500">
                              <th className="py-1">State</th>
                              <th className="py-1">Timestamp</th>
                              <th className="py-1">Duration</th>
                            </tr>
                          </thead>   
                          <tbody>
                            {history.map((ping) => (
                              <tr key={ping.id} className="text-neutral-300">
                                <td className="py-1">{ping.state}</td>
                                <td className="py-1">{new Date(ping.timestamp).toLocaleString()}</td>
                                <td className="py-1">{ping.duration ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>                     
                        </table>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
