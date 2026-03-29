# GraphQL Queries Reference

## Fetch unresolved review threads (paginated)

Use this to find all unresolved review threads from any bot. Filter results client-side by checking `author.login` for bot patterns.

```graphql
query($cursor: String) {
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 5) {
            nodes {
              body
              path
              line
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}
```

## Batch-resolve threads

Resolve multiple threads in a single API call. Build the mutation dynamically based on how many threads need resolving.

```graphql
mutation {
  t1: resolveReviewThread(input: {threadId: "ID1"}) { thread { isResolved } }
  t2: resolveReviewThread(input: {threadId: "ID2"}) { thread { isResolved } }
}
```

## Fetch PR reviews with bot detection

Use the REST API to fetch reviews, then filter by bot authors:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews --paginate
```

Bot detection: any review where `user.login` ends in `[bot]` is a bot review. Group by bot to track satisfaction per bot.
