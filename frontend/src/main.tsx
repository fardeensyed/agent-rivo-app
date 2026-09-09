import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Store = { id: string; name: string; city: string };
type Visit = { id: string; storeId: string; authorId: string; state: string; startedAt: string; draft?: { version: number; title: string; summary: string } };

function App() {
  const [stores, setStores] = useState<Store[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [user, setUser] = useState("user_anika");
  const load = () => Promise.all([
    fetch("http://localhost:3001/api/stores", { headers: { "x-demo-user": user } }).then((r) => r.json()),
    fetch("http://localhost:3001/api/visits", { headers: { "x-demo-user": user } }).then((r) => r.json())
  ]).then(([nextStores, nextVisits]) => { setStores(nextStores); setVisits(nextVisits); });
  useEffect(() => { void load(); }, [user]);
  const active = visits.filter((visit) => ["collecting", "ready_for_review"].includes(visit.state));
  return <main>
    <header><div><span className="eyebrow">AGENT RIVO</span><h1>Field visit reporting</h1></div><select value={user} onChange={(event) => setUser(event.target.value)}><option value="user_anika">Anika Rao</option><option value="user_noah">Noah Bennett</option></select></header>
    <section className="cards"><article><strong>{stores.length}</strong><span>Accessible stores</span></article><article><strong>{visits.filter((v) => v.state === "validated").length}</strong><span>Validated reports</span></article><article><strong>{active.length}</strong><span>Active visits</span></article><article><strong>{visits.filter((v) => v.state === "ready_for_review").length}</strong><span>Awaiting validation</span></article></section>
    <section className="panel"><div className="panel-heading"><h2>Recent visits</h2><button onClick={load}>Refresh</button></div>{visits.length === 0 ? <p className="muted">No visits match these filters.</p> : <table><thead><tr><th>Date</th><th>Store</th><th>State</th><th>Report</th></tr></thead><tbody>{visits.map((visit) => <tr key={visit.id}><td>{new Date(visit.startedAt).toLocaleString()}</td><td>{stores.find((store) => store.id === visit.storeId)?.name ?? visit.storeId}</td><td><span className={`badge ${visit.state}`}>{visit.state.replace(/_/g, " ")}</span></td><td>{visit.draft ? `${visit.draft.title} · v${visit.draft.version}` : "—"}</td></tr>)}</tbody></table>}</section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
