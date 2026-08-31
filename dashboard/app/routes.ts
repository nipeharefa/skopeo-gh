import { type RouteConfig, route } from "@react-router/dev/routes";

export default [
	route("/", "routes/home.tsx"),
	route("repo/:name", "routes/repo.tsx"),
] satisfies RouteConfig;