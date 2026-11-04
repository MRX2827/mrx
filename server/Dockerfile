FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mrx .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /mrx /usr/local/bin/mrx
USER 65532:65532
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["mrx"]
