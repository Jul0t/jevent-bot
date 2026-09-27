import WebSocket from "ws";

import {
  Client,
  GatewayIntentBits
} from "discord.js";

const twitchUsername =
  process.env.TWITCH_BOT_USERNAME;

const twitchToken =
  process.env.TWITCH_BOT_OAUTH_TOKEN;

const apiBaseUrl =
  String(
    process.env.JEVENT_API_URL ?? ""
  ).replace(/\/+$/, "");

const botApiToken =
  process.env.JEVENT_BOT_TOKEN;

const fallbackChannels = [
  ...new Set(
    String(
      process.env.TWITCH_CHANNELS ?? ""
    )
      .split(",")
      .map(channel =>
        channel.trim().toLowerCase()
      )
      .filter(Boolean)
  )
];

if (!twitchUsername || !twitchToken) {
  throw new Error(
    "TWITCH_BOT_USERNAME ou TWITCH_BOT_OAUTH_TOKEN manque."
  );
}

let desiredChannels =
  new Set(fallbackChannels);

let joinedChannels =
  new Set();

let twitchSocket = null;
let reconnectTimer = null;

const stats = new Map();

const viewerStats = new Map();

let liveChannels = new Set();

const statsTestMode =
  process.env.JEVENT_STATS_TEST_MODE ===
  "true";

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

  const values =
    Object.fromEntries(
      parts
        .filter(part =>
          part.type !== "literal"
        )
        .map(part => [
          part.type,
          part.value
        ])
    );

  return (
    `${values.year}-` +
    `${values.month}-` +
    `${values.day}`
  );
}

function getChannelStats(channel) {
  const date = getDateKey();
  const key = `${channel}:${date}`;

  if (!stats.has(key)) {
    stats.set(key, {
      channel,
      date,
      messages: 0,
      emotes: 0
    });
  }

  return stats.get(key);
}

function getParisDateParts(
  date = new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23"
      }
    ).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter(part =>
        part.type !== "literal"
      )
      .map(part => [
        part.type,
        part.value
      ])
  );
}

function getEventDay(
  date = new Date()
) {
  const parts =
    getParisDateParts(date);

  const dateKey =
    `${parts.year}-` +
    `${parts.month}-` +
    `${parts.day}`;

  const hour =
    Number(parts.hour);

  if (
    dateKey === "2026-10-26" &&
    hour >= 16
  ) {
    return 1;
  }

  if (
    dateKey === "2026-10-27"
  ) {
    return 2;
  }

  if (
    dateKey === "2026-10-28"
  ) {
    return 3;
  }

  if (
    dateKey === "2026-10-29" &&
    hour < 4
  ) {
    return 3;
  }

  return null;
}

function getViewerStats({
  channel,
  viewerTwitchId,
  viewerTwitchLogin,
  viewerTwitchDisplayName
}) {
  const now =
    new Date();

  const date =
    getDateKey();

  const key =
    `${viewerTwitchId}:` +
    `${channel}:` +
    `${date}`;

  if (!viewerStats.has(key)) {
    viewerStats.set(
      key,
      {
        channel,
        date,

        eventDay:
          getEventDay(now),

        viewerTwitchId,

        viewerTwitchLogin,

        viewerTwitchDisplayName,

        messages: 0,
        emotes: 0,

        firstSeenAt:
          now.toISOString(),

        lastSeenAt:
          now.toISOString()
      }
    );
  }

  const row =
    viewerStats.get(key);

  row.viewerTwitchLogin =
    viewerTwitchLogin;

  row.viewerTwitchDisplayName =
    viewerTwitchDisplayName;

  row.lastSeenAt =
    now.toISOString();

  return row;
}

function countEmotes(tags) {
  const emotes =
    tags.match(
      /emotes=([^;]*)/
    )?.[1] ?? "";

  if (!emotes) {
    return 0;
  }

  return emotes
    .split("/")
    .reduce(
      (total, group) => {
        const separator =
          group.indexOf(":");

        if (separator === -1) {
          return total;
        }

        const positions =
          group.slice(
            separator + 1
          );

        return (
          total +
          positions
            .split(",")
            .filter(Boolean)
            .length
        );
      },
      0
    );
}

function parseTags(value) {
  const tags = {};

  for (
    const item of value.split(";")
  ) {
    const separator =
      item.indexOf("=");

    if (separator < 0) {
      tags[item] = "";
      continue;
    }

    tags[
      item.slice(0, separator)
    ] =
      item.slice(separator + 1);
  }

  return tags;
}

function handleTwitchLine(line) {
  if (
    line ===
    "PING :tmi.twitch.tv"
  ) {
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

  const message = match[4];

  const channelStats =
    getChannelStats(channel);

  channelStats.messages += 1;

  channelStats.emotes +=
    countEmotes(match[1] ?? "");

  console.log(
    `[Twitch] #${channel} ` +
    `${tags["display-name"] ?? "?"}: ` +
    message
  );

  /*
 * Les statistiques personnelles comptent
 * uniquement lorsque la chaîne est en live.
 */

  if (
    !liveChannels.has(channel)
  ) {
    return;
  }

  const viewerTwitchId =
    String(
      tags["user-id"] ?? ""
    ).trim();

  const viewerTwitchLogin =
    String(
      tags.login ??
      match[2]
        .split("!")[0] ??
      ""
    )
      .trim()
      .toLowerCase();

  const viewerTwitchDisplayName =
    String(
      tags["display-name"] ??
      viewerTwitchLogin
    ).trim();

  /*
   * Ignore les messages du bot lui-même.
   */

  if (
    !viewerTwitchId ||
    viewerTwitchLogin ===
    twitchUsername.toLowerCase()
  ) {
    return;
  }

  const eventDay =
    getEventDay();

  /*
   * En dehors de l’événement, les données ne
   * sont enregistrées que lorsque le mode de
   * test est activé.
   */

  if (
    eventDay === null &&
    !statsTestMode
  ) {
    return;
  }

  const viewerRow =
    getViewerStats({
      channel,
      viewerTwitchId,
      viewerTwitchLogin,
      viewerTwitchDisplayName
    });

  viewerRow.messages += 1;

  viewerRow.emotes +=
    countEmotes(match[1] ?? "");
}

function normalizeChannels(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map(channel =>
          String(channel)
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    )
  ];
}

function synchronizeTwitchChannels() {
  const socket = twitchSocket;

  if (
    !socket ||
    socket.readyState !==
    WebSocket.OPEN
  ) {
    return;
  }

  for (
    const channel of [
      ...joinedChannels
    ]
  ) {
    if (
      desiredChannels.has(channel)
    ) {
      continue;
    }

    socket.send(
      `PART #${channel}`
    );

    joinedChannels.delete(
      channel
    );

    console.log(
      `[Twitch] Canal quitté : ${channel}`
    );
  }

  for (
    const channel of desiredChannels
  ) {
    if (
      joinedChannels.has(channel)
    ) {
      continue;
    }

    socket.send(
      `JOIN #${channel}`
    );

    joinedChannels.add(
      channel
    );

    console.log(
      `[Twitch] Canal rejoint : ${channel}`
    );
  }

  console.log(
    "[Twitch] Chaînes actives :",
    [...desiredChannels].join(", ") ||
    "aucune"
  );
}

async function refreshTwitchChannels() {
  if (!apiBaseUrl || !botApiToken) {
    console.warn(
      "[Twitch] Synchronisation API désactivée : " +
      "JEVENT_API_URL ou JEVENT_BOT_TOKEN manque."
    );

    return;
  }

  try {
    const response = await fetch(
      `${apiBaseUrl}/api/internal/twitch/channels`,
      {
        headers: {
          Authorization:
            `Bearer ${botApiToken}`
        }
      }
    );

    if (!response.ok) {
      const body =
        await response.text();

      throw new Error(
        `HTTP ${response.status} — ${body}`
      );
    }

    const data =
      await response.json();

    const creatorsResponse =
      await fetch(
        `${apiBaseUrl}/api/creators`,
        {
          headers: {
            Accept: "application/json"
          }
        }
      );

    if (creatorsResponse.ok) {
      const creatorsData =
        await creatorsResponse.json();

      const creators =
        Array.isArray(
          creatorsData?.creators
        )
          ? creatorsData.creators
          : [];

      liveChannels =
        new Set(
          creators
            .filter(creator =>
              Boolean(creator.isLive)
            )
            .map(creator =>
              String(
                creator.twitchLogin ?? ""
              )
                .trim()
                .toLowerCase()
            )
            .filter(Boolean)
        );

      console.log(
        "[Twitch] Chaînes en direct :",
        [...liveChannels].join(", ") ||
        "aucune"
      );
    }

    if (
      !Array.isArray(
        data.channels
      )
    ) {
      throw new Error(
        "La réponse ne contient pas de liste de chaînes."
      );
    }

    desiredChannels =
      new Set(
        normalizeChannels(
          data.channels
        )
      );

    synchronizeTwitchChannels();

    console.log(
      "[Twitch] Liste API actualisée :",
      [...desiredChannels]
        .join(", ") ||
      "aucune chaîne"
    );
  } catch (error) {
    console.error(
      "[Twitch] Impossible d’actualiser les chaînes :",
      error.message || error
    );

    console.log(
      "[Twitch] Conservation de la liste précédente."
    );
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  console.log(
    "[Twitch] Reconnexion dans 5 secondes."
  );

  reconnectTimer =
    setTimeout(
      () => {
        reconnectTimer = null;
        connectTwitch();
      },
      5000
    );
}

function connectTwitch() {
  console.log(
    "[Twitch] Connexion au WebSocket…"
  );

  const socket =
    new WebSocket(
      "wss://irc-ws.chat.twitch.tv:443"
    );

  twitchSocket = socket;

  socket.on(
    "open",
    () => {
      console.log(
        "[Twitch] Connexion établie."
      );

      socket.send(
        `PASS ${twitchToken}`
      );

      socket.send(
        `NICK ${twitchUsername}`
      );

      socket.send(
        "CAP REQ :twitch.tv/tags " +
        "twitch.tv/commands " +
        "twitch.tv/membership"
      );

      joinedChannels.clear();

      synchronizeTwitchChannels();
    }
  );

  socket.on(
    "message",
    data => {
      const lines =
        data
          .toString()
          .split("\r\n");

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
          line.endsWith(
            " RECONNECT"
          )
        ) {
          console.log(
            "[Twitch] Reconnexion demandée."
          );

          socket.close();
          return;
        }

        handleTwitchLine(line);
      }
    }
  );

  socket.on(
    "error",
    error => {
      console.error(
        "[Twitch] Erreur :",
        error.message || error
      );
    }
  );

  socket.on(
    "close",
    (code, reason) => {
      if (
        twitchSocket === socket
      ) {
        twitchSocket = null;
      }

      joinedChannels.clear();

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
    }
  );
}

function printStats() {
  console.log(
    "[Stats]",
    JSON.stringify(
      [...stats.values()]
    )
  );
}

async function sendStats() {
  const rows =
    [...stats.values()];

  if (rows.length === 0) {
    return;
  }

  if (!apiBaseUrl || !botApiToken) {
    throw new Error(
      "JEVENT_API_URL ou JEVENT_BOT_TOKEN manque."
    );
  }

  const response = await fetch(
    `${apiBaseUrl}/api/internal/twitch/stats`,
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${botApiToken}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        stats: rows
      })
    }
  );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `HTTP ${response.status} — ${body}`
    );
  }

  console.log(
    `[API] ${rows.length} statistique(s) envoyée(s).`
  );

  stats.clear();
}

async function sendViewerStats() {
  const rows =
    [...viewerStats.values()];

  if (rows.length === 0) {
    return;
  }

  if (!apiBaseUrl || !botApiToken) {
    throw new Error(
      "JEVENT_API_URL ou JEVENT_BOT_TOKEN manque."
    );
  }

  const response = await fetch(
    `${apiBaseUrl}/api/internal/twitch/viewer-stats`,
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${botApiToken}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        stats: rows
      })
    }
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} — ` +
      responseText
    );
  }

  console.log(
    `[API] ${rows.length} ` +
    "statistique(s) viewer envoyée(s)."
  );

  viewerStats.clear();
}

/*
 * Démarrage
 */

await refreshTwitchChannels();

connectTwitch();

setInterval(
  () => {
    void refreshTwitchChannels();
  },
  60_000
);

setInterval(
  async () => {
    printStats();

    try {
      await sendStats();
      await sendViewerStats();
    } catch (error) {
      console.error(
        "[API] Envoi impossible :",
        error.message || error
      );
    }
  },
  60_000
);

/*
 * Le bot Discord reste optionnel.
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