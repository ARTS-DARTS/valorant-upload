let appPromise;

export default async function handler(request, response) {
  process.env.VERCEL_RUNTIME = process.env.VERCEL_RUNTIME || 'serverless';
  appPromise ||= import('../server.js').then(module => module.default);
  const app = await appPromise;
  return app(request, response);
}
