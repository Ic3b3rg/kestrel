import type { FastifyReply, FastifyRequest } from "fastify";

export async function withRequestCancellation<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    return await task(controller.signal);
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  }
}
