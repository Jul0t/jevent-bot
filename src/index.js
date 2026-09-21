import tls from "node:tls";
import WebSocket from "ws";
import {
  Client,
  GatewayIntentBits
} from "discord.js";

const twitchUsername =
  process.env.TWITCH_BOT_USERNAME;

const twitchToken =
  process.env.TWITCH_BOT_OAUTH_TOKEN;

const channels =
  String(
    process.env.TWITCH_CHANNELS ?? ""
  )
    .split(",")
    .map(channel =>
      channel.trim().toLowerCase()
    )
    .filter(Boolean);

if (!twitchUsername || !twitchToken) {
  throw new Error(
    "TWITCH_BOT_USERNAME ou TWITCH_BOT_OAUTH_TOKEN manque."
  );
}

if (channels.length === 0) {
  throw new Error(
    "TWITCH_CHANNELS est vide."
  );
}

const stats = new Map();

function getDateKey() {
  const parts =
    new Intl.DateTimeFormat(
      "fr-FR",
      {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(new Date());

  const values = Object.fromEntries(
    parts
      .filter(part =>
        part.type !== "literal"
      )
      .map(part => [
        part.type,
        part.value
      ])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getChannelStats(channel) {
  const key =
    `${channel}:${getDateKey()}`;

  if (!stats.has(key)) {
    stats.set(key, {
      channel,
      date: getDateKey(),
      messages: 0,
      emotes: 0
    });
  }

  return stats.get(key);
}

function countEmotes(tags) {
  const emotes =
    tags.match(/emotes=([^;]*)/)?.[1] ?? "";

  if (!emotes) {
    return 0;
  }

  return emotes
    .split("/")
    .reduce((total, group) => {
      const separator =
        group.indexOf(":");

      if (separator === -1) {
        return total;
      }

      const positions =
        group.slice(separator + 1);

      return total +
        positions
          .split(",")
          .filter(Boolean)
          .length;
    }, 0);
}

function parseTags(value) {
  const tags = {};

  for (const item of value.split(";")) {
    const separator =
      item.indexOf("=");

    if (separator < 0) {
      tags[item] = "";
      continue;
    }

    tags[item.slice(0, separator)] =
      item.slice(separator + 1);
  }

  return tags;
}

function handleTwitchLine(line) {
  if (line === "PING :tmi.twitch.tv") {
    if (
      twitchSocket?.readyState ===
      WebSocket.OPEN
    ) {
      twitchSocket.send(
        "PONG :tmi.twitch.tv"
      );
    }

    return;
  }

  const match =
    line.match(
      /^(?:@([^ ]+) )?:([^ ]+) PRIVMSG #([^ ]+) :(.*)$/
    );

  if (!match) {
    return;
  }

  const tags =
    parseTags(match[1] ?? "");

  const channel =
    match[3].toLowerCase();

  const message =
    match[4];

  const channelStats =
    getChannelStats(channel);

  channelStats.messages += 1;
  channelStats.emotes +=
    countEmotes(match[1] ?? "");

  console.log(
    `[Twitch] #${channel} ` +
    `${tags["display-name"] ?? "?"}: ` +
    `${message}`
  );
}

let twitchSocket = null;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  console.log(
    "[Twitch] Reconnexion dans 5 secondes."
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTwitch();
  }, 5000);
}

function connectTwitch() {
  console.log(
    "[Twitch] Connexion au WebSocket…"
  );

  const socket = new WebSocket(
    "wss://irc-ws.chat.twitch.tv:443"
  );

  twitchSocket = socket;

  socket.on("open", () => {
    console.log(
      "[Twitch] Connexion établie."
    );

    socket.send(`PASS ${twitchToken}`);
    socket.send(`NICK ${twitchUsername}`);

    socket.send(
      "CAP REQ :twitch.tv/tags " +
      "twitch.tv/commands " +
      "twitch.tv/membership"
    );

    for (const channel of channels) {
      socket.send(`JOIN #${channel}`);
    }

    console.log(
      `[Twitch] Chaînes : ${channels.join(", ")}`
    );
  });

  socket.on("message", data => {
    const lines =
      data.toString().split("\r\n");

    for (const line of lines) {
      if (!line) {
        continue;
      }

      if (
        line.includes("NOTICE") ||
        line.includes("ERROR")
      ) {
        console.log(
          "[Twitch IRC]",
          line
        );
      }

      if (
        line === "RECONNECT" ||
        line.endsWith(" RECONNECT")
      ) {
        console.log(
          "[Twitch] Reconnexion demandée."
        );

        socket.close();
        return;
      }

      handleTwitchLine(line);
    }
  });

  socket.on("error", error => {
    console.error(
      "[Twitch] Erreur :",
      error.message || error
    );
  });

  socket.on("close", (code, reason) => {
    if (twitchSocket === socket) {
      twitchSocket = null;
    }

    console.log(
      "[Twitch] Déconnexion.",
      {
        code,
        reason:
          reason.toString() ||
          "Aucune raison"
      }
    );

    scheduleReconnect();
  });
}

function printStats() {
  console.log(
    "[Stats]",
    JSON.stringify(
      [...stats.values()]
    )
  );
}

connectTwitch();

setInterval(
  async () => {
    printStats();

    try {
      await sendStats();
    } catch (error) {
      console.error(
        "[API] Envoi impossible :",
        error.message
      );
    }
  },
  60_000
);

/*
 * Le bot Discord reste optionnel pour le moment.
 * Si DISCORD_TOKEN est configuré, il se connecte.
 */
if (process.env.DISCORD_TOKEN) {
  const discord =
    new Client({
      intents: [
        GatewayIntentBits.Guilds
      ]
    });

  discord.once(
    "ready",
    client => {
      console.log(
        `[Discord] Connecté comme ${client.user.tag}.`
      );
    }
  );

  discord.login(
    process.env.DISCORD_TOKEN
  );
}

async function sendStats() {
  const rows = [...stats.values()];

  if (rows.length === 0) {
    return;
  }

  const response = await fetch(
    `${process.env.JEVENT_API_URL}/api/internal/twitch/stats`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${process.env.JEVENT_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        stats: rows
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `HTTP ${response.status} — ${body}`
    );
  }

  console.log(
    `[API] ${rows.length} statistique(s) envoyée(s).`
  );

  stats.clear();
}
