import grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
import { protocols } from '@v2ray-manager/generator';

const root = protobuf.loadSync(fileURLToPath(new URL('./v2ray-api.proto', import.meta.url)));
const namespace = 'v2ray.core.app.proxyman.command';
const type = name => root.lookupType(`${namespace}.${name}`);
const encode = (name, value) => Buffer.from(type(name).encode(value).finish());
const requestType = type('AlterInboundRequest');
const responseType = type('AlterInboundResponse');
const HandlerClient = grpc.makeGenericClientConstructor({
  alterInbound: {
    path: `/${namespace}.HandlerService/AlterInbound`,
    requestStream: false,
    responseStream: false,
    requestSerialize: value => encode('AlterInboundRequest', value),
    requestDeserialize: value => requestType.decode(value),
    responseSerialize: value => encode('AlterInboundResponse', value),
    responseDeserialize: value => responseType.decode(value),
  },
}, 'HandlerService');
const ports = { vless: 53217, vmess: 53218, trojan: 53219 };
const typedMessage = (name, value) => ({ typeUrl: `types.v2fly.org/${name}`, value });

export function createV2rayApi(address) {
  if (!address) throw new Error('V2RAY_API_ADDRESS is required');
  const client = new HandlerClient(address, grpc.credentials.createInsecure());
  function alter(protocol, operation, value, expectedMessage) {
    if (!protocols.includes(protocol)) throw new TypeError('Unsupported tunnel protocol');
    return new Promise((resolve, reject) => {
      client.alterInbound({
        tag: `${protocol}-${ports[protocol]}`,
        operation: typedMessage(`${namespace}.${operation}`, encode(operation, value)),
      }, { deadline: Date.now() + 5000 }, error => {
        if (!error) return resolve();
        if (error.code === grpc.status.UNKNOWN && error.details === expectedMessage) return resolve();
        reject(error);
      });
    });
  }
  return {
    add(protocol, connection) {
      const email = `connection-${connection.id}`;
      return alter(protocol, 'AddUserOperation', {
        user: {
          email,
          account: typedMessage(`v2ray.core.proxy.${protocol}.Account`,
            encode('Credential', { value: connection.credential })),
        },
      }, `proxy/${protocol}${protocol === 'vmess' ? '/inbound' : ''}: User ${email} already exists.`);
    },
    remove(protocol, connection) {
      const email = `connection-${connection.id}`;
      return alter(protocol, 'RemoveUserOperation', { email },
        `proxy/${protocol}${protocol === 'vmess' ? '/inbound' : ''}: User ${email} not found.`);
    },
    close() { client.close(); },
  };
}
