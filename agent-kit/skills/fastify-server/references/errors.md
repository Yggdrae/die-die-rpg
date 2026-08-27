# HTTP Error Rules

Use one repository-wide error envelope. Example only:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource not found"
  }
}
```

Map business/application failures to HTTP at the boundary. Do not expose stack traces, SQL details, internal object names, or secrets.
