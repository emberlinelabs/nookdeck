// Embedded text assets (Bun `with { type: "text" }`): the Windows PowerShell helper.
declare module "*.ps1" {
  const text: string;
  export default text;
}
declare module "*.svg" { const text: string; export default text; }
declare module "*.css" { const text: string; export default text; }
