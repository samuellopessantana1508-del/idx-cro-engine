drop policy if exists tenant_users_manage_owner on public.tenant_users;
drop policy if exists offers_write_admin on public.offers;
drop policy if exists smart_links_write_admin on public.smart_links;
drop policy if exists meta_mapping_write_admin on public.meta_campaign_mappings;

create policy tenant_users_insert_owner
on public.tenant_users for insert
to authenticated
with check (idx_private.has_tenant_role(tenant_id, array['owner']));

create policy tenant_users_update_owner
on public.tenant_users for update
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner']))
with check (idx_private.has_tenant_role(tenant_id, array['owner']));

create policy tenant_users_delete_owner
on public.tenant_users for delete
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner']));

create policy offers_insert_operator
on public.offers for insert
to authenticated
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy offers_update_operator
on public.offers for update
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy offers_delete_operator
on public.offers for delete
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy smart_links_insert_operator
on public.smart_links for insert
to authenticated
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy smart_links_update_operator
on public.smart_links for update
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy smart_links_delete_operator
on public.smart_links for delete
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin','operator']));

create policy meta_mapping_insert_admin
on public.meta_campaign_mappings for insert
to authenticated
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

create policy meta_mapping_update_admin
on public.meta_campaign_mappings for update
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']))
with check (idx_private.has_tenant_role(tenant_id, array['owner','admin']));

create policy meta_mapping_delete_admin
on public.meta_campaign_mappings for delete
to authenticated
using (idx_private.has_tenant_role(tenant_id, array['owner','admin']));
