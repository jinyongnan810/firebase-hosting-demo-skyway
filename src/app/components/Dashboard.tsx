import { useAppDispatch, useAppSelector } from "../hooks";
import React, { useEffect } from "react";
import { Redirect, useHistory } from "react-router";
import Messages from "./Messages";
import UserList from "./meeting/UserList";
import Settings from "./meeting/Settings";
import * as wstypes from "../websocket/types";
import * as types from "../actions/types";
import ConnectedAudioList from "./meeting/ConnectedAudioList";
import { showMessages } from "../actions/messages";
// skyway
import Peer, { SfuRoom } from "skyway-js";
interface RTCPeerInfo {
  id: string;
  rtcConn: RTCPeerConnection;
  stream?: MediaStream;
}
let ws: WebSocket | null;
let peer: Peer | null;
let room: SfuRoom | null;
let rtcConnections: Map<string, RTCPeerInfo> = new Map();
let localStream: MediaStream | null = null;
let localStreamLoading = false;
let standByIceCandidates: { [id: string]: RTCIceCandidate[] } = {};
const rtcConfig = {
  // iceCandidatePoolSize: 2,
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};
const offerOptions = {
  offerToReceiveAudio: true,
  offerToReceiveVideo: false,
};

const sendMsg = (type: string, data: Object) => {
  if (ws) {
    const msg = { type, data };
    ws.send(JSON.stringify(msg));
  }
};
// skyway
const createPeer = (id: string) => {
  peer = new Peer(id, { key: process.env.SKYWAY_KEY! });
};

const getLocalStream = async (audioDevice: string | null = null) => {
  try {
    if (localStreamLoading) {
      return;
    }
    if (localStream) {
      return;
    }
    localStreamLoading = true;
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: audioDevice ? { deviceId: { exact: audioDevice } } : true,
      video: false,
    });
    console.log(localStream);
    localStreamLoading = false;
  } catch (error) {
    console.error(`Cannot get localstream:${JSON.stringify(error)}`);
  }
};
const stopLocalStream = async () => {
  try {
    if (localStream) {
      localStream.getTracks().forEach(function (track) {
        track.stop();
      });
      localStream = null;
    }
  } catch (error) {
    console.error(`Cannot stop localstream:${JSON.stringify(error)}`);
  }
};

const getPermissions = async () => {
  (await navigator.mediaDevices.getUserMedia({ video: true, audio: true }))
    .getTracks()
    .forEach((track) => track.stop());
};

const Dashboard = () => {
  const { isAuthenticated, loading, user } = useAppSelector(
    (state) => state.auth
  );
  const userlist = useAppSelector((state) => state.meeting.users);
  const dispatch = useAppDispatch();

  const joinRoom = (to: string) => {
    if (!room) {
      sendMsg(wstypes.JOIN_ROOM, { to });
      joinSkyWayRoom(to);
    }
  };
  const joinSkyWayRoom = async (id: string) => {
    if (!peer || !peer.open) {
      console.error("Peer not created!");
      return;
    }
    await getLocalStream();
    if (!localStream) {
      console.error(`No local stream!`);
      return;
    }
    room = peer.joinRoom(id, {
      mode: "sfu",
      stream: localStream,
    }) as SfuRoom;
    room.once("open", () => {
      console.log(`Room ${room!.name} opened!`);
    });
    room.on("stream", (stream) => {
      const user = stream.peerId;
      dispatch({
        type: types.REMOVE_AUDIO,
        payload: user,
      });
      dispatch({
        type: types.ADD_AUDIO,
        payload: { id: user, stream: stream },
      });
    });
    room.on("peerLeave", (user) => {
      dispatch({
        type: types.REMOVE_AUDIO,
        payload: user,
      });
    });
    room.on("close", () => {
      dispatch({
        type: types.CLEAR_AUDIO,
        payload: user,
      });
    });
  };
  const exitRoom = () => {
    dispatch({ type: types.CLEAR_AUDIO });
    room!.close();
    room = null;
    sendMsg(wstypes.EXIT_ROOM, {});
  };
  const changeLocalStream = async (audioDeviceId: string) => {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    localStream = null;
    await getLocalStream(audioDeviceId);
    room!.replaceStream(localStream!);
  };
  useEffect(() => {
    if (isAuthenticated) {
      // get device permissions
      getPermissions().then(() => {
        // check permissions
        navigator.permissions.query({ name: "microphone" }).then((res) => {
          if (res.state !== "granted") {
            dispatch(
              showMessages("error", [
                { message: "Microphone access is not permitted!" },
              ])
            );
          }
        });
      });
      // create peer
      createPeer(user!.id!);

      // create websocket
      ws = new WebSocket(process.env.WEBSOCKET_URL!);
      ws.onopen = (e) => {
        console.log("Connected to server.");
      };
      ws.onmessage = async (e) => {
        const data = JSON.parse(e.data);
        switch (data.type) {
          case wstypes.CURRENT_USERS:
            dispatch({ type: types.UPDATE_USERS, payload: data.data });
            break;
          case wstypes.I_JOINED_ROOM:
            const joined = data.data.id;
            if (!room) {
              joinSkyWayRoom(user!.id!);
            }
            break;
          case wstypes.I_EXITED_ROOM:
            dispatch({ type: types.REMOVE_AUDIO, payload: data.data.id });
            // no one else is in the room, then exit
            if (room && room.members.length === 0) {
              exitRoom();
            }
            break;

          case wstypes.ERROR:
            const errors = data.data;
            dispatch(
              showMessages(
                "error",
                errors.map((e: string) => ({ message: e }))
              )
            );
          default:
            console.log(`Unknown type:${data.type}`);
        }
      };
      ws.onclose = (e) => {
        console.error("Websocket closed.");
        dispatch(showMessages("error", [{ message: "Websocket closed." }]));
      };
    }
    // clean connections when leaving the page
    return function cleanUp() {
      if (ws) {
        if (room) {
          room.close();
          room = null;
        }
        if (peer) {
          peer.disconnect();
          peer = null;
        }
        ws!.close();
        ws = null;

        dispatch({ type: types.CLEAR_AUDIO });
      }
    };
  }, [loading]);
  useEffect(() => {
    if (user) {
      const me = userlist.filter((u) => u.id === user.id)[0];
      if (me && me.status === "idle") {
        stopLocalStream();
      }
    }
  }, [userlist]);
  return (
    <div>
      <Messages />
      <UserList me={user?.id} joinRoom={joinRoom} exitRoom={exitRoom} />
      <ConnectedAudioList />
      <Settings changeLocalStream={changeLocalStream} />
    </div>
  );
};

export default Dashboard;
export { RTCPeerInfo };
