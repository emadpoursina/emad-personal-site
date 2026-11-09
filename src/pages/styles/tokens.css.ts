export const prerender = true;
import tokensCss from '../../styles/tokens.css?raw';

export function GET() {
  return new Response(tokensCss, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
    },
  });
}
