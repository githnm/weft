import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  Database,
  Loader2,
  Plug,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VerificationCallout } from "@/components/verification-callout";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  activateConnection,
  createConnection,
  fetchConnections,
  removeConnection,
  testConnectionDraft,
  testSavedConnection,
  type ConnectionDraft,
  type ConnectionMeta,
  type ConnectorType,
  type TestResult,
} from "@/lib/api";

type Mode = { kind: "list" } | { kind: "add" };

export function ConnectionsScreen() {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    fetchConnections()
      .then((r) => setConnections(r.connections))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 4000);
  };

  if (mode.kind === "add") {
    return (
      <AddConnectionForm
        onCancel={() => setMode({ kind: "list" })}
        onSaved={(name) => {
          refresh();
          flash(`Connection “${name}” saved.`);
          setMode({ kind: "list" });
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-normal tracking-tight">Connections</h1>
          <p className="text-sm text-muted-foreground">
            Databases Weft can read. Credentials are stored only on this machine — never in the
            browser, never committed.
          </p>
        </div>
        <Button size="sm" onClick={() => setMode({ kind: "add" })}>
          <Plus className="size-3.5" />
          Add connection
        </Button>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3.5 py-2.5 text-sm text-muted-foreground">
          <Check className="size-3.5 text-success" strokeWidth={2.5} />
          {notice}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading connections…
        </div>
      )}
      {error && !loading && (
        <div className="rounded-lg border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Couldn’t load connections.</span> {error}
        </div>
      )}

      {!loading && !error && connections.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-14 text-center">
          <Plug className="size-5 text-muted-foreground" strokeWidth={1.75} />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">No connections yet</span>
            <span className="text-sm text-muted-foreground">
              Add a Postgres or BigQuery connection, or keep using env vars.
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={() => setMode({ kind: "add" })}>
            <Plus className="size-3.5" />
            Add connection
          </Button>
        </div>
      )}

      {!loading && !error && connections.length > 0 && (
        <div className="flex flex-col gap-3">
          {connections.map((c) => (
            <ConnectionCard key={c.id} conn={c} onChanged={refresh} onNotice={flash} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Saved connection card ────────────────────────────────────────

function ConnectionCard({
  conn,
  onChanged,
  onNotice,
}: {
  conn: ConnectionMeta;
  onChanged: () => void;
  onNotice: (msg: string) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const test = () => {
    setTesting(true);
    setResult(null);
    testSavedConnection(conn.id)
      .then(setResult)
      .catch((e) => setResult({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setTesting(false));
  };

  const activate = () => {
    setBusy(true);
    activateConnection(conn.id)
      .then(() => onChanged())
      .catch((e) => onNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <Database className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
              {conn.name}
              {conn.active && <Badge variant="success">active</Badge>}
            </CardTitle>
            <CardDescription className="font-mono text-xs">{conn.masked}</CardDescription>
          </div>
          <Badge variant="outline">{conn.type}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
            {testing ? "Testing…" : "Test"}
          </Button>
          {!conn.active && (
            <Button size="sm" variant="ghost" onClick={activate} disabled={busy}>
              Set active
            </Button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            className="ml-auto flex items-center gap-1.5 text-sm text-destructive/80 transition-colors hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
        </div>

        {conn.active && (
          <p className="text-xs text-muted-foreground">Used by Ask, model design, and refine.</p>
        )}

        {result?.ok && (
          <VerificationCallout kind="verified" title="Connection works">
            Connected successfully.
          </VerificationCallout>
        )}
        {result && !result.ok && (
          <VerificationCallout kind="caveat" title="Connection failed">
            {result.error}
          </VerificationCallout>
        )}
      </CardContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-destructive" />
            <span>
              Delete <span className="font-mono">{conn.name}</span>?
            </span>
          </AlertDialogTitle>
          <AlertDialogDescription>
            Removes this connection from the local config file. Your database is not affected. Env-var
            config (if any) keeps working.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              setConfirmDelete(false);
              removeConnection(conn.id)
                .then(() => {
                  onNotice(`Deleted “${conn.name}”.`);
                  onChanged();
                })
                .catch((e) => onNotice(e instanceof Error ? e.message : String(e)));
            }}
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialog>
    </Card>
  );
}

// ── Add-connection form ──────────────────────────────────────────

function AddConnectionForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (name: string) => void;
}) {
  const [type, setType] = useState<ConnectorType>("duckdb");
  const [name, setName] = useState("");
  // Postgres / MySQL
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [sslmode, setSslmode] = useState("no-verify"); // postgres
  const [mysqlSsl, setMysqlSsl] = useState(false);
  // BigQuery
  const [projectId, setProjectId] = useState("");
  const [location, setLocation] = useState("US");
  const [keyFilePath, setKeyFilePath] = useState("");
  // DuckDB
  const [filePath, setFilePath] = useState("");
  // Snowflake
  const [account, setAccount] = useState("");
  const [sfUser, setSfUser] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [sfSchema, setSfSchema] = useState("PUBLIC");
  const [sfRole, setSfRole] = useState("");
  const [sfPassword, setSfPassword] = useState("");
  const [sfKeyPath, setSfKeyPath] = useState("");
  const [sfPassphrase, setSfPassphrase] = useState("");

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = (): ConnectionDraft => {
    switch (type) {
      case "postgres":
        return { type, name: name.trim(), host: host.trim(), port: Number(port) || 5432, database: database.trim(), user: user.trim(), password, sslmode: sslmode.trim() || "no-verify" };
      case "mysql":
        return { type, name: name.trim(), host: host.trim(), port: Number(port) || 3306, database: database.trim(), user: user.trim(), password, ssl: mysqlSsl };
      case "bigquery":
        return { type, name: name.trim(), project_id: projectId.trim(), location: location.trim() || "US", key_file_path: keyFilePath.trim() || undefined };
      case "duckdb":
        return { type, name: name.trim(), file_path: filePath.trim() };
      case "snowflake":
        return {
          type, name: name.trim(), account: account.trim(), username: sfUser.trim(), warehouse: warehouse.trim(),
          database: database.trim(), schema: sfSchema.trim() || "PUBLIC", role: sfRole.trim() || undefined,
          password: sfPassword || undefined, private_key_path: sfKeyPath.trim() || undefined,
          private_key_passphrase: sfPassphrase || undefined,
        };
    }
  };

  const complete = Boolean(
    name.trim() &&
      (type === "postgres" || type === "mysql"
        ? host.trim() && database.trim() && user.trim() && password
        : type === "bigquery"
          ? projectId.trim()
          : type === "duckdb"
            ? filePath.trim()
            : /* snowflake */ account.trim() && sfUser.trim() && warehouse.trim() && database.trim() && (sfPassword || sfKeyPath.trim())),
  );

  const test = () => {
    if (!complete || testing) return;
    setTesting(true);
    setResult(null);
    setError(null);
    testConnectionDraft(draft())
      .then(setResult)
      .catch((e) => setResult({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setTesting(false));
  };

  const save = () => {
    if (!complete || saving) return;
    setSaving(true);
    setError(null);
    createConnection(draft())
      .then((meta) => {
        setPassword(""); // never re-display the secret
        onSaved(meta.name);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
      <button
        onClick={onCancel}
        className="flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Connections
      </button>

      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-normal tracking-tight">Add a connection</h1>
        <p className="text-sm text-muted-foreground">
          Stored on this machine in <span className="font-mono text-xs">.weft/connections.json</span>{" "}
          (gitignored). The password is sent once to be saved locally and is never shown again.
        </p>
      </div>

      {/* Type selector */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {([
          ["duckdb", "DuckDB"],
          ["postgres", "Postgres"],
          ["mysql", "MySQL"],
          ["bigquery", "BigQuery"],
          ["snowflake", "Snowflake"],
        ] as [ConnectorType, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => {
              setType(t);
              setResult(null);
              if (t === "mysql") setPort((p) => p || "3306");
              if (t === "postgres") setPort((p) => p || "5432");
            }}
            className={cn(
              "rounded-md border px-3 py-2 text-sm transition-colors",
              type === t ? "border-foreground bg-muted text-foreground" : "border-border hover:bg-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-4">
        <Field label="Name" hint="A label for this connection (e.g. “prod” or “local-parquet”).">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod" />
        </Field>

        {type === "duckdb" && (
          <Field
            label="File path"
            hint="Point at a .duckdb file or a Parquet/CSV — no server needed. The zero-setup path: introspect and ask a local file directly."
          >
            <Input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="/Users/you/data/events.parquet"
              className="font-mono"
            />
          </Field>
        )}

        {(type === "postgres" || type === "mysql") && (
          <>
            <Field
              label="Host"
              hint={
                type === "postgres"
                  ? "Supabase: use the pooler host (aws-N-region.pooler.supabase.com), NOT db.<ref>.supabase.co (often IPv6-only)."
                  : "The MySQL host (e.g. PlanetScale: aws.connect.psdb.cloud)."
              }
            >
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder={type === "postgres" ? "aws-0-us-east-1.pooler.supabase.com" : "aws.connect.psdb.cloud"} className="font-mono" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Port" hint={type === "postgres" ? "Supabase: session pooler 5432, not 6543." : "Default 3306."}>
                <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder={type === "postgres" ? "5432" : "3306"} className="font-mono" />
              </Field>
              <Field label="Database">
                <Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={type === "postgres" ? "postgres" : "mydb"} className="font-mono" />
              </Field>
            </div>
            <Field label="User">
              <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder={type === "postgres" ? "postgres.xxxx" : "root"} className="font-mono" />
            </Field>
            <Field label="Password" hint="Stored locally; the @, !, : etc. are encoded for you.">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            {type === "postgres" ? (
              <Field label="SSL mode" hint="Cloud Postgres (Supabase / Neon / RDS): use no-verify.">
                <div className="flex gap-1.5">
                  {["no-verify", "require", "disable"].map((m) => (
                    <button key={m} onClick={() => setSslmode(m)} className={cn("rounded-md border px-2.5 py-1 font-mono text-xs transition-colors", sslmode === m ? "border-foreground bg-muted text-foreground" : "border-border text-muted-foreground hover:bg-muted")}>
                      {m}
                    </button>
                  ))}
                </div>
              </Field>
            ) : (
              <Field label="SSL" hint="Cloud MySQL (PlanetScale, RDS) requires SSL — enable it.">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={mysqlSsl} onChange={(e) => setMysqlSsl(e.target.checked)} />
                  Require SSL
                </label>
              </Field>
            )}
          </>
        )}

        {type === "bigquery" && (
          <>
            <Field label="Project ID">
              <Input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="my-gcp-project" className="font-mono" />
            </Field>
            <Field label="Location" hint="BigQuery dataset region.">
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="US" className="font-mono" />
            </Field>
            <Field
              label="Service-account key file (optional)"
              hint="Leave blank to use gcloud Application Default Credentials (run `gcloud auth application-default login`). Otherwise give a PATH to a key file — never paste the key contents."
            >
              <Input value={keyFilePath} onChange={(e) => setKeyFilePath(e.target.value)} placeholder="/Users/you/.config/gcloud/key.json" className="font-mono" />
            </Field>
          </>
        )}

        {type === "snowflake" && (
          <>
            <Field
              label="Account identifier"
              hint="Use the org-account form: <orgname>-<account_name> (e.g. myorg-myaccount). Not the full URL."
            >
              <Input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="myorg-myaccount" className="font-mono" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="User">
                <Input value={sfUser} onChange={(e) => setSfUser(e.target.value)} placeholder="ANALYST" className="font-mono" />
              </Field>
              <Field label="Warehouse">
                <Input value={warehouse} onChange={(e) => setWarehouse(e.target.value)} placeholder="COMPUTE_WH" className="font-mono" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Database">
                <Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="ANALYTICS" className="font-mono" />
              </Field>
              <Field label="Schema">
                <Input value={sfSchema} onChange={(e) => setSfSchema(e.target.value)} placeholder="PUBLIC" className="font-mono" />
              </Field>
            </div>
            <Field label="Role (optional)">
              <Input value={sfRole} onChange={(e) => setSfRole(e.target.value)} placeholder="ANALYST_ROLE" className="font-mono" />
            </Field>
            <Field label="Password" hint="Password auth. For key-pair auth, leave this blank and set the private key path below.">
              <Input type="password" value={sfPassword} onChange={(e) => setSfPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            <Field
              label="Private key file (key-pair auth, optional)"
              hint="Alternative to password: a PATH to your private key PEM (never the contents). Add the passphrase if the key is encrypted."
            >
              <Input value={sfKeyPath} onChange={(e) => setSfKeyPath(e.target.value)} placeholder="/Users/you/.ssh/snowflake_key.p8" className="font-mono" />
            </Field>
            {sfKeyPath.trim() && (
              <Field label="Key passphrase (optional)">
                <Input type="password" value={sfPassphrase} onChange={(e) => setSfPassphrase(e.target.value)} placeholder="••••••••" />
              </Field>
            )}
          </>
        )}
      </div>

      {/* Test result — surface the REAL connection error clearly. */}
      {result?.ok && (
        <VerificationCallout kind="verified" title="Connection works">
          Connected successfully — you can save it.
        </VerificationCallout>
      )}
      {result && !result.ok && (
        <VerificationCallout kind="caveat" title="Connection failed">
          {result.error}
        </VerificationCallout>
      )}
      {error && (
        <VerificationCallout kind="caveat" title="Couldn’t save">
          {error}
        </VerificationCallout>
      )}

      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={test} disabled={!complete || testing}>
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!complete || saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {saving ? "Saving…" : "Save connection"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {children}
    </label>
  );
}
