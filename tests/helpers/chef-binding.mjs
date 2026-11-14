/** Exercise the actual private Chef worker without a listening network server. */
export async function attachChefBinding(sources, env, { bindings = () => env } = {}) {
  const { default: worker } = await sources.import("worker/chef.ts");
  env.CHEF = {
    async fetch(url, options) {
      return worker.fetch(new Request(url, options), bindings());
    },
  };
}
