// A mock Ollama /api/embed server on loopback for tests/phase12.sh. Prints its
// port on the first line, then serves until killed. Topic-count vectors, so
// "cat" is near "feline" and far from "engine".
import * as http from 'node:http';

const TOPICS = [/\b(cat|feline|kitten|pet|sofa)\b/gi, /\b(car|engine|tires?|vehicle)\b/gi, /\b(soup|recipe|kitchen)\b/gi];
const vectorOf = (text: string): number[] => {
  const v = TOPICS.map((re) => (text.match(re) ?? []).length);
  return [...v, v.every((x) => x === 0) ? 1 : 0];
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { input } = JSON.parse(body) as { input: string[] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ embeddings: input.map(vectorOf) }));
  });
});
server.listen(0, '127.0.0.1', () => console.log((server.address() as { port: number }).port));
