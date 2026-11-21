-- Feature 07 task 05: what a device needs to prove a complete offline export. Exact pins stream to
-- every reader of the campaign; attachment metadata and the identity of preserved import chunks
-- stream to the `export` capability holders only (`campaign_export_metadata`). The projected
-- columns exclude `object_key`, `payload`, and audit identities.
ALTER PUBLICATION "powersync" ADD TABLE "public"."campaign_system_pins";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."campaign_module_pins";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."attachments";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."import_preserved_chunks";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."campaign_system_pins" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."campaign_module_pins" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."attachments" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."import_preserved_chunks" TO "powersync_replicator";
