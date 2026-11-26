/** Anything shaped like a ticket key (SAL-123). Look-alikes (UTF-8) fall out when no tracker knows them. */
export const ticketsIn = (text: string) => [...new Set(text.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g) ?? [])];

/** Comments on a Linear issue. False when Linear doesn't know the key. */
async function linear(key: string, text: string, dryRun: boolean): Promise<boolean> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return false;
  const call = async <T>(query: string, variables: object): Promise<T | undefined> => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return ((await res.json()) as { data?: T }).data;
  };
  const found = await call<{ issue?: { id: string } }>("query($id: String!) { issue(id: $id) { id } }", { id: key });
  const issueId = found?.issue?.id;
  if (!issueId) return false;
  if (dryRun) return true;
  const made = await call<{ commentCreate?: { success: boolean } }>(
    "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
    { input: { issueId, body: text } },
  );
  return Boolean(made?.commentCreate?.success);
}

/** Comments on a Jira issue (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN). False when Jira doesn't know the key. */
async function jira(key: string, text: string, dryRun: boolean): Promise<boolean> {
  const { JIRA_BASE_URL: base, JIRA_EMAIL: email, JIRA_API_TOKEN: token } = process.env;
  if (!base || !email || !token) return false;
  const headers = { authorization: `Basic ${btoa(`${email}:${token}`)}`, "content-type": "application/json", accept: "application/json" };
  const issue = await fetch(`${base}/rest/api/3/issue/${key}?fields=summary`, { headers });
  if (!issue.ok) return false;
  if (dryRun) return true;
  const doc = { type: "doc", version: 1, content: text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) };
  const res = await fetch(`${base}/rest/api/3/issue/${key}/comment`, { method: "POST", headers, body: JSON.stringify({ body: doc }) });
  return res.ok;
}

/** Posts the text on up to 3 tickets that Linear or Jira knows; returns the keys it reached. */
export async function commentOnTickets(keys: string[], text: string, dryRun = false): Promise<string[]> {
  const reached: string[] = [];
  for (const key of keys) {
    if (reached.length === 3) break;
    if ((await linear(key, text, dryRun)) || (await jira(key, text, dryRun))) reached.push(key);
  }
  return reached;
}
