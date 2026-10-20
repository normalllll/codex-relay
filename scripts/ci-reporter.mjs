import { inspect } from "node:util";

const escape = (value) => String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

// Public check annotations retain failure details even when Actions logs require authentication.
export default async function* report(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { name, file, line, details } = event.data;
    const location = file ? ` file=${escape(file).replaceAll(",", "%2C")}${line ? `,line=${line}` : ""}` : "";
    yield `::error${location}::${escape(`${name}\n${inspect(details?.error, { depth: 6, colors: false })}`)}\n`;
  }
}
