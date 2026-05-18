export function stripBoilerplate(html: string): string {
  return html
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/cookie notice/gi, "");
}
