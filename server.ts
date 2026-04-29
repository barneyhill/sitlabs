import path from 'path';

console.log("Starting SITLabs server with Bun...");
const projectRoot = import.meta.dir;

Bun.serve({
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    console.log(`[${req.method}] ${pathname}`);

    if (pathname === '/genorxiv/' || pathname === '/genorxiv') {
      const indexFile = Bun.file(path.join('public', 'genorxiv', 'index.html'));
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }

    if (pathname === '/genomie/' || pathname === '/genomie') {
      const indexFile = Bun.file(path.join('public', 'genomie', 'index.html'));
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }

    const publicDir = path.join(projectRoot, 'public');
    let filePath = path.join(publicDir, pathname);
    if (pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');

    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);

    const fileWithIndex = Bun.file(path.join(filePath, 'index.html'));
    if (await fileWithIndex.exists()) return new Response(fileWithIndex);

    return new Response("404: Not Found", { status: 404 });
  },
  error(error) {
    console.error("Server Error:", error);
    return new Response("An internal error occurred", { status: 500 });
  }
});

console.log(`Server listening on http://localhost:8080`);
