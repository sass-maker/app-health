export function advertisePublicHtml(request: Request, response: Response): Response;
export function publicHtmlResponse(
  request: Request,
  assets?: { fetch(request: Request): Promise<Response> },
): Promise<Response | null>;
export const publicPages: Record<string, string>;
export const publicRoutes: Array<{
  path: string;
  url: string;
  md: string;
  title: string;
  description: string;
}>;
export const publicIdentity: { name: string; origin: string; title: string; summary: string };
export function handlePublicDocument(request: Request): Promise<Response | null>;
