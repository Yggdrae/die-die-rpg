# Route Pattern

```ts
const Params = Type.Object({ id: Type.String({ minLength: 1 }) });
const Reply = Type.Object({ id: Type.String() });

app.get(
  "/resources/:id",
  {
    schema: {
      params: Params,
      response: { 200: Reply },
    },
  },
  async (request, reply) => {
    const result = await getResource.execute(request.params.id);
    return reply.code(200).send(result);
  },
);
```

Adapt to repository conventions. Do not create a second validation/error/auth system if one already exists.
