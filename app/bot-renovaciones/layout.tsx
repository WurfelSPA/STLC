// La campaña se puede ejecutar desde el panel (server action) y crea/envía
// ~100 casos en una corrida: margen de tiempo amplio para esta ruta.
export const maxDuration = 300;

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
