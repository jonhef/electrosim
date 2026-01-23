# build stage
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY Engine.csproj ./
COPY Electro ./Electro

RUN dotnet restore

COPY . .
RUN dotnet publish -c Release -o /app/publish --no-restore

# runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app

ENV ASPNETCORE_URLS=http://+:5000
EXPOSE 5000

COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Engine.dll"]
