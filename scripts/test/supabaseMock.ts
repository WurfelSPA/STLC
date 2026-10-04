// Mock mínimo de supabase-js en memoria para probar la campaña sin red.
type Fila = Record<string, unknown>;
export const db: Record<string, Fila[]> = {};
let seq = 0;

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filtros: ((f: Fila) => boolean)[] = [];
  private op: "select" | "update" | "delete" = "select";
  private patch: Fila = {};
  private rango: [number, number] | null = null;
  private unico = false;
  constructor(private tabla: string) { db[tabla] ??= []; }
  select() { return this; }
  eq(c: string, v: unknown) { this.filtros.push(f => f[c] === v); return this; }
  gte(c: string, v: string) { this.filtros.push(f => String(f[c]) >= v); return this; }
  lte(c: string, v: string) { this.filtros.push(f => String(f[c]) <= v); return this; }
  not(c: string, _op: "in", lista: string) {
    const vals = lista.replace(/[()]/g, "").split(",");
    this.filtros.push(f => !vals.includes(String(f[c])));
    return this;
  }
  order() { return this; }
  limit() { return this; }
  range(a: number, b: number) { this.rango = [a, b]; return this; }
  maybeSingle() { this.unico = true; return this; }
  update(p: Fila) { this.op = "update"; this.patch = p; return this; }
  delete() { this.op = "delete"; return this; }
  insert(rows: Fila | Fila[]) {
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      db[this.tabla].push({
        id: `c${++seq}`, estado: "PENDIENTE", paso: "MENU", contexto: {}, motivo: null, requiere_ejecutivo: false,
        atendido: false, hitos_enviados: [], respondio: false, opt_out: false, trackgts_actualizado: false,
        plazo_meses: null, monto: null, nueva_fecha_vencimiento: null, cerrado_por: null, creado_en: new Date().toISOString(), ...r,
      });
    }
    return Promise.resolve({ error: null });
  }
  then<T>(ok: (v: { data: unknown; error: null }) => T) {
    const filas = db[this.tabla].filter(f => this.filtros.every(fn => fn(f)));
    if (this.op === "update") { filas.forEach(f => Object.assign(f, structuredClone(this.patch))); return Promise.resolve(ok({ data: null, error: null })); }
    if (this.op === "delete") { db[this.tabla] = db[this.tabla].filter(f => !filas.includes(f)); return Promise.resolve(ok({ data: null, error: null })); }
    let data: unknown = structuredClone(this.rango ? filas.slice(this.rango[0], this.rango[1] + 1) : filas);
    if (this.unico) data = (data as Fila[])[0] ?? null;
    return Promise.resolve(ok({ data, error: null }));
  }
}

export function getSupabaseAdmin() {
  return { from: (t: string) => new Query(t) };
}
