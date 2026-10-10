# Superchat's engine: any Omnigent server image (`omnigent-server`, a named build context) plus
# this folder at /opt/bundle (agent bundles, config templates, start script). It builds nothing of
# Omnigent's, so the base can come from Omnigent's own Dockerfile or any variant of it.
# Compose wires it (infra/compose/docker-compose.superchat.yaml); by hand, from the repo root:
#   docker build -t superchat/omnigent-server:local --build-arg OMNIGENT_EXTRAS=memory,postgres \
#     -f engine/omnigent/deploy/docker/Dockerfile engine/omnigent
#   docker build -t superchat/engine:local -f infra/omnigent/Dockerfile \
#     --build-context omnigent-server=docker-image://superchat/omnigent-server:local infra/omnigent
FROM omnigent-server
COPY . /opt/bundle/
RUN rm -f /opt/bundle/Dockerfile /opt/bundle/Dockerfile.dockerignore \
 && chmod -R a+rX /opt/bundle \
 && chmod 755 /opt/bundle/engine/start.sh \
 && sed -i 's/\r$//' /opt/bundle/engine/start.sh
CMD ["/opt/bundle/engine/start.sh"]
